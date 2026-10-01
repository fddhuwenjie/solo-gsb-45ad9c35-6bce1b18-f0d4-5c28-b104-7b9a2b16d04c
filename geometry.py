"""投影机选位几何计算核心。

坐标约定（顶视图）：房间左上角为原点，x 轴向右，y 轴由幕布墙指向后墙，单位米。
幕布安装在 y=0 的前墙上，中心 x 坐标为 screen["cx"]。
投影机镜头位置记为 (px, py)，镜头位于机身前表面中央，
因此机身占据矩形 [px-bw/2, px+bw/2] × [py, py+bd]。

每个镜头方案的可安装区域 = 以下约束的交集：
  1. 投射距离：py ∈ [tr_min*Sw, tr_max*Sw]
  2. 镜头水平位移：px ∈ [cx-hs, cx+hs]
  3. 墙面余量：机身矩形不得越出四墙内缩 margin 的范围
  4. 机身避障：机身矩形不得与任何禁装区相交
交集为空时给出导致为空的约束诊断。

退化可行域（安装线）：水平镜头位移为 0（或位移带被墙面余量夹成单点）
时，px 固定为某一 x，可安装区域退化为一条纵深线段。只要线段长度大于 0
即可沿纵深安放机身，因此线段同样视为可行域（面积为 0 但 line_length > 0）。
此时禁装区仍按机身尺寸膨胀，仅当膨胀后的 x 区间覆盖该固定 x（含严格内点，
边界接触不算碰撞），才把其 y 区间投影为纵深禁段从安装线上扣除；线段被全部
覆盖时才给出避障无解诊断。
"""

EPS = 1e-9
SNAP_EPS = 0.005          # 幕布条带边缘配平容差（5mm，吸收 UI 步进误差）


def rect_w(r):
    return max(0.0, r[2] - r[0])


def rect_h(r):
    return max(0.0, r[3] - r[1])


def rect_area(r):
    return rect_w(r) * rect_h(r)


def rects_intersect(a, b):
    return (min(a[2], b[2]) - max(a[0], b[0]) > EPS and
            min(a[3], b[3]) - max(a[1], b[1]) > EPS)


def interval_hit(a, b, lo, hi):
    """开区间式重叠判定：区间 (a,b) 与 (lo,hi) 是否有严格大于 EPS 的重叠。
    边界接触（端点相等或间隙 ≤ EPS）不算命中，与矩形扣除的接触规则一致。
    当 a==b（固定 x 的安装线退化为点）时按严格包含判定。"""
    if abs(b - a) <= EPS:
        return lo + EPS < a < hi - EPS
    return min(b, hi) - max(a, lo) > EPS


def subtract_interval(seg, lo, hi):
    """从纵深线段 seg=(a,b) 中扣除禁段 (lo,hi)，返回剩余线段。
    与 subtract_rect 的接触规则一致：禁段与线段无内部重叠（间隙 ≤ EPS 或
    仅在端点相接）时不扣；严格进入线段内部才切除；切除后剩余碎段
    长度 ≤ EPS 时丢弃（仅余单个接触点即视为该线段被完全覆盖）。"""
    a, b = seg
    ia, ib = max(a, lo), min(b, hi)
    if ib - ia <= EPS:
        return [tuple(seg)]
    out = []
    if ia - a > EPS:
        out.append((a, ia))
    if b - ib > EPS:
        out.append((ib, b))
    return out


def subtract_rect(rect, hole):
    """从 rect 中减去 hole，返回 0~4 个互不重叠的矩形（用于禁装区扣除）。"""
    x1, y1, x2, y2 = rect
    hx1, hy1, hx2, hy2 = hole
    ix1, iy1 = max(x1, hx1), max(y1, hy1)
    ix2, iy2 = min(x2, hx2), min(y2, hy2)
    if ix1 >= ix2 - EPS or iy1 >= iy2 - EPS:
        return [list(rect)]
    out = []
    if ix1 - x1 > EPS:
        out.append([x1, y1, ix1, y2])          # 左条
    if x2 - ix2 > EPS:
        out.append([ix2, y1, x2, y2])          # 右条
    if iy1 - y1 > EPS:
        out.append([ix1, y1, ix2, iy1])        # 上条
    if y2 - iy2 > EPS:
        out.append([ix1, iy2, ix2, y2])        # 下条
    return out


def _derive(room, screen, scheme):
    """汇总方案派生量。"""
    sw, sh = screen["width"], screen["height"]
    return {
        "W": room["width"], "D": room["depth"], "H": room["height"],
        "m": room.get("margin", 0.0),
        "Sw": sw, "Sh": sh,
        "cx": screen["cx"], "sb": screen["bottom"],
        "sc": screen["bottom"] + sh / 2.0,               # 幕布中心高度
        "bw": scheme["body_w"], "bd": scheme["body_d"], "bh": scheme["body_h"],
        "d_min": scheme["tr_min"] * sw,                  # 最近投射距离
        "d_max": scheme["tr_max"] * sw,                  # 最远投射距离
        "hs": scheme["h_shift"] * sw,                    # 水平位移半宽（米）
        "vs": scheme["v_shift"] * sh,                    # 垂直位移半高（米）
    }


def _obstacle_rect(ob):
    return [ob["x"], ob["y"], ob["x"] + ob["w"], ob["y"] + ob["h"]]


def compute_scheme(room, screen, scheme, obstacles, point=None, lens_height=None,
                   sub_screen=None, service=None):
    """计算单个方案的可安装区域、面积、诊断与选点校验。

    sub_screen={"width","cx"}：多机拼接时，方案只负责幕布的一个覆盖区间，
        区间宽度替代整幅幕宽参与投射比/水平位移计算，区间中心决定水平位移中心。
    service=(gx, gy)：多机拼接时的机身检修净距（横向/纵深，米）。给出后，
        禁装区按“机身尺寸 + 双侧检修净距”膨胀（即检修包络不与禁装区相交）。
    """
    if sub_screen:
        screen = dict(screen, width=sub_screen["width"], cx=sub_screen["cx"])
    gx = gy = 0.0
    if service:
        gx, gy = service[0], service[1]
    g = _derive(room, screen, scheme)
    W, D, H, m = g["W"], g["D"], g["H"], g["m"]
    cx, hs, sc, vs = g["cx"], g["hs"], g["sc"], g["vs"]
    bw, bd, bh = g["bw"], g["bd"], g["bh"]
    d_min, d_max = g["d_min"], g["d_max"]

    diags = []

    # ---- 各约束区间 ----
    wall_x = (m + bw / 2, W - m - bw / 2)     # 墙面余量（水平，机身不越界）
    shift_x = (cx - hs, cx + hs)              # 镜头水平位移
    wall_y = (m, D - m - bd)                  # 墙面余量（纵深，机身在镜头后方）
    throw_y = (d_min, d_max)                  # 投射距离
    fit_z = (bh / 2, H - bh / 2)              # 机身不穿出地板/天花板
    shift_z = (sc - vs, sc + vs)              # 镜头垂直位移

    x_rng = (max(wall_x[0], shift_x[0]), min(wall_x[1], shift_x[1]))
    y_rng = (max(wall_y[0], throw_y[0]), min(wall_y[1], throw_y[1]))
    z_rng = (max(fit_z[0], shift_z[0]), min(fit_z[1], shift_z[1]))

    x_ok = x_rng[1] - x_rng[0] > -EPS
    y_ok = y_rng[1] - y_rng[0] > -EPS
    z_ok = z_rng[1] - z_rng[0] > -EPS

    # ---- 交集为空时定位元凶约束 ----
    if not x_ok:
        if wall_x[1] < wall_x[0]:
            diags.append(
                f"墙面余量约束不可满足：机身宽 {bw:.2f}m + 两侧余量 {2 * m:.2f}m "
                f"超过房间宽 {W:.2f}m")
        elif shift_x[0] > wall_x[1]:
            diags.append(
                f"镜头水平位移与墙面余量冲突：幕布中心偏右（cx={cx:.2f}m），"
                f"位移仅 ±{hs:.2f}m，机身无法避开右墙余量")
        elif shift_x[1] < wall_x[0]:
            diags.append(
                f"镜头水平位移与墙面余量冲突：幕布中心偏左（cx={cx:.2f}m），"
                f"位移仅 ±{hs:.2f}m，机身无法避开左墙余量")
        else:
            diags.append("镜头水平位移范围与墙面余量范围无交集")
    if not y_ok:
        if wall_y[1] < wall_y[0]:
            diags.append(
                f"墙面余量约束不可满足：机深 {bd:.2f}m + 前后余量 {2 * m:.2f}m "
                f"超过房间进深 {D:.2f}m")
        elif throw_y[0] > wall_y[1]:
            diags.append(
                f"投射距离与墙面余量冲突：最小投射距离 {throw_y[0]:.2f}m "
                f"大于可用进深 {wall_y[1]:.2f}m（投射比过大或房间太浅）")
        elif throw_y[1] < wall_y[0]:
            diags.append(
                f"投射距离与墙面余量冲突：最大投射距离 {throw_y[1]:.2f}m "
                f"小于前墙余量 {wall_y[0]:.2f}m")
        else:
            diags.append("投射距离范围与墙面余量范围无交集")
    if not z_ok:
        if fit_z[1] < fit_z[0]:
            diags.append(f"房间净高 {H:.2f}m 容不下机身高 {bh:.2f}m")
        elif shift_z[0] > fit_z[1]:
            diags.append(
                f"镜头垂直位移与房间净高冲突：幕布中心 {sc:.2f}m 过高且向下位移 "
                f"仅 {vs:.2f}m，机身将顶到天花板")
        elif shift_z[1] < fit_z[0]:
            diags.append(
                f"镜头垂直位移与地板冲突：幕布中心 {sc:.2f}m 过低且向上位移 "
                f"仅 {vs:.2f}m，机身将触地")
        else:
            diags.append("镜头垂直位移范围与房间净高范围无交集")

    # ---- 顶视图可安装区域 = 基础矩形 − 各禁装区（按机身尺寸膨胀）----
    # x 区间退化为单点时，可行域是固定 x 的一条纵深安装线（面积为 0 但长度可 > 0）
    base_rect = None
    region = []
    area = 0.0
    line_length = 0.0
    domain = "empty"
    if x_ok and y_ok:
        base_rect = [x_rng[0], y_rng[0], x_rng[1], y_rng[1]]
        expanded = [[ob["x"] - bw / 2 - gx, ob["y"] - bd - gy,
                     ob["x"] + ob["w"] + bw / 2 + gx, ob["y"] + ob["h"] + gy]
                    for ob in obstacles]
        if rect_h(base_rect) <= EPS:
            # 纵深也退化为点：线长为 0，无法安放机身
            region = [list(base_rect)]
            if rect_w(base_rect) <= EPS:
                diags.append("可安装区域退化为点（水平位移与投射距离均无余量），实际无法安放机身")
            else:
                diags.append("可安装区域退化为无纵深的条带（投射距离无余量），实际无法安放机身")
        elif rect_w(base_rect) <= EPS:
            # ---- 退化可行域：固定 x 的安装线 ----
            x0 = x_rng[0]
            domain = "line"
            segs = [(y_rng[0], y_rng[1])]
            hit_idx = []
            for i, exp in enumerate(expanded):
                # 固定 x 被膨胀禁装区的 x 区间严格覆盖（边界接触不算）才需要扣除
                if not interval_hit(x0, x0, exp[0], exp[2]):
                    continue
                hit_idx.append(i)
                nxt = []
                for seg in segs:
                    nxt.extend(subtract_interval(seg, exp[1], exp[3]))
                segs = nxt
            line_length = sum(b - a for a, b in segs)
            region = [[x0, a, x0, b] for a, b in segs]
            if line_length <= EPS and hit_idx:
                # 逐一移除禁装区做恢复测试，找出覆盖整条安装线的元凶
                names = []
                for i in hit_idx:
                    rest = [(y_rng[0], y_rng[1])]
                    for j in hit_idx:
                        if i == j:
                            continue
                        nxt = []
                        for seg in rest:
                            nxt.extend(subtract_interval(seg, expanded[j][1], expanded[j][3]))
                        rest = nxt
                    if sum(b - a for a, b in rest) > EPS:
                        names.append(obstacles[i].get("name") or f"#{i + 1}")
                if names:
                    diags.append("机身避障约束不可满足：禁装区 " +
                                 "、".join(f"「{n}」" for n in names) +
                                 " 完全覆盖了安装线段")
                else:
                    diags.append("机身避障约束不可满足：多个禁装区组合完全覆盖了安装线段")
        else:
            # ---- 普通二维可安装区域 ----
            domain = "area"
            region = [list(base_rect)]
            for exp in expanded:
                nxt = []
                for r in region:
                    nxt.extend(subtract_rect(r, exp))
                region = nxt
            area = sum(rect_area(r) for r in region)
            if area <= EPS:
                # 逐一移除禁装区做恢复测试，找出覆盖可安装区域的元凶
                names = []
                for i, exp in enumerate(expanded):
                    if not rects_intersect(base_rect, exp):
                        continue
                    rest = [list(base_rect)]
                    for j, exp2 in enumerate(expanded):
                        if i == j:
                            continue
                        nxt = []
                        for r in rest:
                            nxt.extend(subtract_rect(r, exp2))
                        rest = nxt
                    if sum(rect_area(r) for r in rest) > EPS:
                        names.append(obstacles[i].get("name") or f"#{i + 1}")
                if names:
                    diags.append("机身避障约束不可满足：禁装区 " +
                                 "、".join(f"「{n}」" for n in names) +
                                 " 完全覆盖了可安装区域")
                else:
                    diags.append("机身避障约束不可满足：多个禁装区组合完全覆盖了可安装区域")

    # ---- 当前选点校验 ----
    pt = None
    if point is not None:
        px, py = point["x"], point["y"]
        hz = lens_height if lens_height is not None else sc
        body = [px - bw / 2 - gx, py - gy, px + bw / 2 + gx, py + bd + gy]
        ob_hit = None
        for i, ob in enumerate(obstacles):
            if rects_intersect(body, _obstacle_rect(ob)):
                ob_hit = ob.get("name") or f"#{i + 1}"
                break
        checks = {
            "throw": throw_y[0] - EPS <= py <= throw_y[1] + EPS,
            "shift": shift_x[0] - EPS <= px <= shift_x[1] + EPS,
            "wall": (wall_x[0] - EPS <= px <= wall_x[1] + EPS and
                     wall_y[0] - EPS <= py and py + bd <= D - m + EPS),
            "obstacle": ob_hit is None,
            "height": bool(z_ok) and z_rng[0] - EPS <= hz <= z_rng[1] + EPS,
        }
        pt = {
            "x": px, "y": py, "z": hz,
            "ok": all(checks.values()),
            "checks": checks,
            "obstacle_hit": ob_hit,
            "throw_distance": py,
            "throw_ratio": py / g["Sw"] if g["Sw"] else 0.0,
            "h_shift_used": (px - cx) / g["Sw"] if g["Sw"] else 0.0,
            "v_shift_used": (hz - sc) / g["Sh"] if g["Sh"] else 0.0,
        }

    feasible = bool(x_ok and y_ok and z_ok and
                    (area > EPS or line_length > EPS))
    return {
        "id": scheme.get("id"),
        "name": scheme.get("name", "方案"),
        "feasible": feasible,
        "domain": domain,
        "area": round(area, 4),
        "line_length": round(line_length, 4),
        "base_rect": [round(v, 4) for v in base_rect] if base_rect else None,
        "region": [[round(v, 4) for v in r] for r in region],
        "diagnostics": diags,
        "ranges": {
            "x": [round(v, 4) for v in x_rng] if x_ok else None,
            "y": [round(v, 4) for v in y_rng] if y_ok else None,
            "z": [round(v, 4) for v in z_rng] if z_ok else None,
            "throw": [round(d_min, 4), round(d_max, 4)],
            "shift_x": [round(v, 4) for v in shift_x],
            "shift_z": [round(v, 4) for v in shift_z],
        },
        "derived": {
            "d_min": round(d_min, 4), "d_max": round(d_max, 4),
            "hs": round(hs, 4), "vs": round(vs, 4), "sc": round(sc, 4),
        },
        "point": pt,
    }


# ============================== 多机拼接规划 ==============================
#
# 同一幕布被划成 n（2~3）个有序覆盖区间 zones，每个区间选择一台设备（镜头方案）。
# 第 i 台设备的“虚拟幕布”宽为区间宽度、中心为区间中心，因此复用 compute_scheme
# 即可得到各自的可安装域（墙面余量、垂直位移、禁装区扣除全部沿用），其中禁装区
# 按 [bw/2+gx, bd+gy] 膨胀（检修包络不触禁装区）。
#
# 第 i 台设备机身膨胀后的检修包络（顶视图）：
#     [px-bw/2-gx, px+bw/2+gx] × [py-gy, py+bd+gy]
# 联合约束：任意两台设备的检修包络严格不相交（边界接触允许，与其余碰撞规则一致）。
#
# 覆盖结构由调用方给出：区间以幕布左缘为起点连续排布，左缘为 0、右缘为幕宽，
# 相邻区间重叠不得小于各自要求的最小拼接重叠。

def _device_service(zone):
    gx = float(zone.get("service_x", zone.get("service", 0.0)))
    gy = float(zone.get("service_y", zone.get("service", 0.0)))
    return max(0.0, gx), max(0.0, gy)


def zone_layout(screen_width, zones):
    """按“左缘为 0、相邻区间以最小重叠相接”排布区间。

    返回 (lefts, rights, diags)：
      lefts[i]  第 i 区间左缘（米，相对幕布左缘）
      rights[i] 第 i 区间右缘
    正确结构：第 1 区间左缘 0；区间从左到右（左缘不回退）；末区间右缘等于幕宽
    （SNAP_EPS 内，吸收 UI 步进误差）；最小重叠不超过相邻两区间宽度。
    """
    diags = []
    n = len(zones)
    if n < 2 or n > 3:
        return None, None, [f"拼接机台数必须为 2~3 台（当前 {n} 台）"]
    lefts, rights = [], []
    prev_right = 0.0
    for i, z in enumerate(zones):
        w = float(z["width"])
        if w <= 0.0:
            diags.append(f"区间 {i + 1}「{z.get('name', '')}」宽度必须大于 0")
            lefts.append(prev_right)
            rights.append(prev_right)
            continue
        if i == 0:
            left = 0.0
        else:
            ov = max(0.0, float(z.get("min_overlap", 0.0)))
            left = prev_right - ov
            cap = min(float(zones[i - 1]["width"]), w)
            if ov > cap + EPS:
                diags.append(
                    f"区间 {i}/{i + 1} 最小拼接重叠 {ov:.2f}m 大于较窄区间宽度 "
                    f"{cap:.2f}m，无法实现")
            if left + EPS < lefts[-1]:
                diags.append(
                    f"区间 {i + 1} 左缘回退到区间 {i} 左缘左侧（重叠 "
                    f"{ov:.2f}m 超过区间 {i} 宽度 {float(zones[i - 1]['width']):.2f}m），"
                    f"区间必须从左到右排布")
        lefts.append(left)
        rights.append(left + w)
        prev_right = left + w
    if not diags and abs(rights[-1] - screen_width) > SNAP_EPS:
        gap = screen_width - rights[-1]
        diags.append(
            f"覆盖区间未连续覆盖整幅幕布：末区间右缘 {rights[-1]:.2f}m，幕宽 "
            f"{screen_width:.2f}m，{'缺口' if gap > 0 else '超出'} {abs(gap):.2f}m"
            "（请调整区间宽度或相邻重叠，使区间首尾相接铺满幕布）")
    return lefts, rights, diags


def validate_zones(screen_width, zones):
    """兼容入口：返回 (placements, diags)，placements 为 [[left,right], ...]。"""
    lefts, rights, diags = zone_layout(screen_width, zones)
    if lefts is None:
        return None, diags
    return [[l, r] for l, r in zip(lefts, rights)], diags


def _service_envelope(pt, scheme, gx, gy):
    bw, bd = scheme["body_w"], scheme["body_d"]
    px, py = pt[0], pt[1]
    return [px - bw / 2 - gx, py - gy, px + bw / 2 + gx, py + bd + gy]


def _pair_hole_xy(scheme_i, gx_i, gy_i, scheme_j, gx_j, gy_j, pt_j):
    """设备 j（位于 pt_j）的检修包络对设备 i 镜头点形成的禁用矩形。

    设备 i 的检修包络不得与 j 的检修包络严格相交，展开到 i 的镜头坐标：
        px_i ∈ [pjx-bwj/2-gxj-bwi/2-gxi, pjx+bwj/2+gxj+bwi/2+gxi]
        py_i ∈ [pjy-gyj-bdi-gyi, pjy+bdj+gyj+gyi]
    """
    bwi, bdi = scheme_i["body_w"], scheme_i["body_d"]
    pxj, pyj = pt_j
    return [
        pxj - scheme_j["body_w"] / 2 - gx_j - bwi / 2 - gx_i,
        pyj - gy_j - bdi - gy_i,
        pxj + scheme_j["body_w"] / 2 + gx_j + bwi / 2 + gx_i,
        pyj + scheme_j["body_d"] + gy_j + gy_i,
    ]


def _cells(res):
    """把 compute_scheme 的可行域转成单元列表：('line',x,y1,y2) 或 ('area',rect)。"""
    if not res["feasible"]:
        return []
    if res["domain"] == "line":
        out = []
        for r in res["region"]:
            if r[3] - r[1] > EPS:
                out.append(("line", r[0], r[1], r[3]))
        return out
    out = []
    for r in res["region"]:
        if (r[2] - r[0] > EPS and r[3] - r[1] > EPS):
            out.append(("area", r))
    return out


def _subtract_cells(cells, hole):
    """从单元集合中扣除一个矩形洞。线段单元投影扣除 y 段；矩形单元矩形扣除。"""
    out = []
    for c in cells:
        if c[0] == "line":
            _, x0, y1, y2 = c
            if not interval_hit(x0, x0, hole[0], hole[2]):
                out.append(c)
                continue
            for a, b in subtract_interval((y1, y2), hole[1], hole[3]):
                if b - a > EPS:
                    out.append(("line", x0, a, b))
        else:
            for r in subtract_rect(c[1], hole):
                if rect_w(r) > EPS and rect_h(r) > EPS:
                    out.append(("area", r))
    return out


def _cell_candidates(c, corners):
    """单元上的候选镜头点：退化线段取端点；矩形取角点（或中心）。"""
    if c[0] == "line":
        _, x0, y1, y2 = c
        return [(x0, y1), (x0, y2)]
    x1, y1, x2, y2 = c[1]
    if corners:
        return [(x1, y1), (x2, y1), (x1, y2), (x2, y2)]
    return [((x1 + x2) / 2, (y1 + y2) / 2)]


def _point_in_cells(pt, cells):
    for c in cells:
        if c[0] == "line":
            if abs(pt[0] - c[1]) <= EPS and c[2] - EPS <= pt[1] <= c[3] + EPS:
                return True
        else:
            r = c[1]
            if (r[0] - EPS <= pt[0] <= r[2] + EPS and
                    r[1] - EPS <= pt[1] <= r[3] + EPS):
                return True
    return False


def _solve(dev_cells, meta, pinned, ignore_pairs=None):
    """回溯求一组同时满足所有检修包络互斥约束的安装点。

    dev_cells: 每台设备的初始可行单元（已扣禁装区）。
    meta: 每台设备的 (scheme, gx, gy)。
    pinned: {i: (x,y)} 固定的设备；其余自由。
    ignore_pairs: 忽略的设备对集合（联合无解时用于定位冲突对）。
    成功返回 {i:(x,y)}，失败返回 None。
    """
    n = len(dev_cells)
    ignore = ignore_pairs or set()
    fixed = dict(pinned)
    # 固定点必须落在各自可行域内
    for i, pt in fixed.items():
        if not _point_in_cells(pt, dev_cells[i]):
            return None
    assignment = dict(fixed)

    def residual_for(i):
        cells = dev_cells[i]
        sch_i, gx_i, gy_i = meta[i]
        for j, pj in assignment.items():
            if tuple(sorted((i, j))) in ignore:
                continue
            sch_j, gx_j, gy_j = meta[j]
            hole = _pair_hole_xy(sch_i, gx_i, gy_i, sch_j, gx_j, gy_j, pj)
            cells = _subtract_cells(cells, hole)
        return cells

    def recurse():
        free = [i for i in range(n) if i not in assignment]
        if not free:
            return True
        # MRV：选剩余可行单元最少/最受限的设备
        best = None
        for i in free:
            cells = residual_for(i)
            score = (len(cells), sum(c[3] - c[2] for c in cells if c[0] == "line")
                     + sum(rect_area(c[1]) for c in cells if c[0] == "area"))
            if not cells:
                return False
            if best is None or score < best[0]:
                best = (score, i, cells)
        _, i, cells = best
        # 候选点：各矩形角点、线段端点（接触合法时角点即充分），
        # 再加各单元中心兜底（角点被对侧包络同时夹住的内部情形）
        tried = set()
        for use_corners in (True, False):
            for c in cells:
                for cand in _cell_candidates(c, use_corners):
                    key = (round(cand[0], 6), round(cand[1], 6))
                    if key in tried:
                        continue
                    tried.add(key)
                    assignment[i] = cand
                    if recurse():
                        return True
                    del assignment[i]
        return False

    return dict(assignment) if recurse() else None


def _pair_clash(scheme_i, gxi, gyi, pti, scheme_j, gxj, gyj, ptj):
    """两台设备的检修包络是否严格相交。"""
    a = _service_envelope(pti, scheme_i, gxi, gyi)
    b = _service_envelope(ptj, scheme_j, gxj, gyj)
    return rects_intersect(a, b)


def compute_blend(room, screen, schemes_by_id, zones, obstacles,
                  points=None, lens_heights=None):
    """多机拼接联合规划。

    schemes_by_id: {scheme_id: scheme dict}，zones[i]["scheme_id"] 选择镜头方案。
    points/lens_heights: 与 zones 等长；points[i] 为 {"x","y"} 或 None（自由）。
    返回联合状态、每台安装域与诊断；不抛几何异常（结构问题以 status 表达）。
    """
    sw, sh = screen["width"], screen["height"]
    n = len(zones)
    points = points or [None] * n
    lens_heights = lens_heights or [None] * n
    if len(points) != n or len(lens_heights) != n:
        raise ValueError("points / lens_heights 必须与 zones 等长")
    joint_diags = []

    placements, struct_diags = validate_zones(sw, zones)
    structure_ok = not struct_diags
    joint_diags.extend(struct_diags)
    if placements is None:
        placements = [[0.0, float(z.get("width", 0.0) or 0.0)] for z in zones]

    devices = []
    lefts = [p[0] for p in placements]
    any_bad_scheme = False
    for i, z in enumerate(zones):
        scheme = schemes_by_id.get(z.get("scheme_id"))
        gx, gy = _device_service(z)
        if scheme is None:
            any_bad_scheme = True
            devices.append({"zone_index": i, "scheme": None, "gx": gx, "gy": gy,
                            "left": lefts[i] if i < len(lefts) else 0.0,
                            "result": None})
            joint_diags.append(f"区间 {i + 1}「{z.get('name', '')}」未选择镜头方案")
            continue
        width = float(z["width"])
        left = lefts[i] if i < len(lefts) else 0.0
        zcx = screen["cx"] - sw / 2 + left + width / 2
        sub = {"width": width, "cx": zcx}
        pt, lh = points[i], lens_heights[i]
        res = compute_scheme(room, screen, scheme, obstacles,
                             point=pt, lens_height=lh,
                             sub_screen=sub, service=(gx, gy))
        devices.append({"zone_index": i, "scheme": scheme, "gx": gx, "gy": gy,
                        "left": left, "width": width, "cx": zcx, "result": res})
    if any_bad_scheme:
        structure_ok = False

    # 覆盖结构：实际左缘/右缘/邻接重叠（供条带与诊断显示）
    coverage = []
    for i, d in enumerate(devices):
        if "width" not in d:
            coverage.append({"left": None, "right": None})
            continue
        coverage.append({"left": round(d["left"], 4),
                         "right": round(d["left"] + d["width"], 4)})
    for i in range(n - 1):
        req = max(0.0, float(zones[i + 1].get("min_overlap", 0.0)))
        if i + 1 < len(devices) and "width" in devices[i] and "width" in devices[i + 1]:
            actual = devices[i]["left"] + devices[i]["width"] - devices[i + 1]["left"]
            coverage[i + 1]["overlap_prev"] = round(actual, 4)
            coverage[i + 1]["min_overlap"] = round(req, 4)
            if structure_ok and actual + SNAP_EPS < req:
                joint_diags.append(
                    f"区间 {i}/{i + 1} 拼接重叠仅 {actual:.2f}m，"
                    f"小于要求的 {req:.2f}m")
                structure_ok = False

    base_feasible = all(d["result"] and d["result"]["feasible"] for d in devices)
    if not base_feasible:
        for d in devices:
            r = d["result"]
            if r is not None and not r["feasible"]:
                for msg in r["diagnostics"]:
                    joint_diags.append(f"区间 {d['zone_index'] + 1}「{r['name']}」无解：{msg}")

    # ---- 联合求解 ----
    meta = [(d["scheme"], d["gx"], d["gy"]) for d in devices]
    dev_cells = [_cells(d["result"]) if d["result"] else [] for d in devices]
    pinned = {}
    for i, pt in enumerate(points):
        if pt is not None:
            pinned[i] = (float(pt["x"]), float(pt["y"]))

    free_solution = None
    pair_conflicts = []
    if structure_ok and base_feasible:
        free_solution = _solve(dev_cells, meta, {})
        if free_solution is None:
            # 逐一（至多 3 对）忽略设备对，定位互斥冲突来源
            for a in range(n):
                for b in range(a + 1, n):
                    if _solve(dev_cells, meta, {}, ignore_pairs={(a, b)}):
                        pair_conflicts.append((a, b))
            if pair_conflicts:
                names = []
                for a, b in pair_conflicts:
                    names.append(f"区间 {a + 1}「{devices[a]['result']['name']}」× "
                                 f"区间 {b + 1}「{devices[b]['result']['name']}」")
                joint_diags.append(
                    "联合约束冲突：设备对 " + "、".join(names) +
                    " 的检修包络在各自可行域内无法同时避让（无满足机身检修净距的安装点组合）")
            else:
                joint_diags.append(
                    "联合约束冲突：多台设备的检修包络互斥约束组合无解"
                    "（需放宽检修净距、调整区间或改造禁装区）")

    # ---- 已给安装点（拖动后）的固定求解与逐点诊断 ----
    pin_solution = None
    pin_violations = [[] for _ in range(n)]
    pin_status = "free"
    if structure_ok and base_feasible and pinned:
        pin_solution = _solve(dev_cells, meta, pinned)
        # 逐点静态诊断：越出本台可行域 / 镜头高度不可行
        for i, pt in pinned.items():
            r = devices[i]["result"]
            p = r["point"]
            if not _point_in_cells(pt, dev_cells[i]):
                reasons = []
                if p:
                    if not p["checks"]["throw"]:
                        reasons.append("投射距离超出镜头投射比范围")
                    if not p["checks"]["shift"]:
                        reasons.append("超出镜头水平位移范围")
                    if not p["checks"]["wall"]:
                        reasons.append("机身越出墙面余量")
                    if not p["checks"]["obstacle"]:
                        reasons.append(f"检修包络与禁装区「{p['obstacle_hit']}」相交")
                pin_violations[i].append(
                    "安装点不在本台可安装域内：" + ("、".join(reasons) or "被禁装区/墙面扣除"))
            if p is not None and not p["checks"]["height"]:
                zr = r["ranges"]["z"]
                pin_violations[i].append(
                    f"镜头高度 {p['z']:.2f}m 超出垂直位移可行范围"
                    + (f" {zr[0]:.2f}–{zr[1]:.2f}m" if zr else ""))
        # 设备对检修包络相交（固定点之间，以及固定点与自由解设备之间）
        ref_pos = dict(free_solution or {})
        ref_pos.update(pinned)
        for a in range(n):
            if a not in pinned:
                continue
            for b in range(n):
                if b == a or b not in ref_pos:
                    continue
                da, db = devices[a], devices[b]
                if _pair_clash(da["scheme"], da["gx"], da["gy"], ref_pos[a],
                               db["scheme"], db["gx"], db["gy"], ref_pos[b]):
                    pin_violations[a].append(
                        f"检修包络与区间 {b + 1}「{db['result']['name']}」相交"
                        f"（横向/纵深检修净距 {da['gx']:.2f}/{da['gy']:.2f}m、"
                        f"{db['gx']:.2f}/{db['gy']:.2f}m 未同时满足）")
        # 几何回溯无解（固定点组合本身放不下）时，静态检查应已覆盖越域与
        # 两两包络相交；若仍无逐点诊断（多设备组合死锁），给每个固定点补一条
        any_violation = any(pin_violations[i] for i in pinned)
        if pin_solution is None and not any_violation:
            for i in pinned:
                pin_violations[i].append(
                    "该固定点与其他设备的可行域组合互斥：保留此点时其余设备"
                    "无法全部布置（多设备检修包络组合死锁），可双击解锁改回自动布点")
            any_violation = True
        if pin_solution is not None and not any_violation:
            pin_status = "ok"
        else:
            pin_status = "conflict"
        for i, vs in enumerate(pin_violations):
            for msg in vs:
                joint_diags.append(f"区间 {i + 1} 安装点冲突：{msg}")

    if not structure_ok:
        status = "structure_error"
    elif not base_feasible:
        status = "device_infeasible"
    elif free_solution is None:
        status = "joint_conflict"
    elif pin_status == "conflict":
        status = "pin_conflict"
    else:
        status = "ok"

    # 拖动冲突时：固定设备显示其固定点（带逐点诊断），自由设备采纳自由解
    chosen = dict(free_solution) if free_solution is not None else {}
    if pin_solution is not None:
        chosen = dict(pin_solution)
    elif pin_status == "conflict":
        for i, pt in pinned.items():
            chosen[i] = pt
    zone_results = []
    for i, d in enumerate(devices):
        r = d["result"]
        item = {
            "index": i,
            "name": zones[i].get("name") or (r["name"] if r else f"区间 {i + 1}"),
            "scheme_id": zones[i].get("scheme_id"),
            "left": round(d["left"], 4) if "width" in d else None,
            "width": d.get("width"),
            "cx": round(d["cx"], 4) if "cx" in d else None,
            "service": [round(d["gx"], 4), round(d["gy"], 4)],
            "min_overlap_next": round(max(0.0, float(zones[i].get("min_overlap", 0.0))), 4),
            "pinned": i in pinned,
            "violations": pin_violations[i],
        }
        if r is not None:
            item.update({
                "scheme_name": r["name"],
                "feasible": r["feasible"],
                "domain": r["domain"],
                "area": r["area"],
                "line_length": r["line_length"],
                "region": r["region"],
                "base_rect": r["base_rect"],
                "ranges": r["ranges"],
                "derived": r["derived"],
                "diagnostics": r["diagnostics"],
            })
        else:
            item.update({"feasible": False, "domain": "empty", "area": 0.0,
                         "line_length": 0.0, "region": [], "base_rect": None,
                         "ranges": None, "derived": None, "diagnostics": []})
        if chosen is not None and i in chosen:
            x, y = chosen[i]
            gx, gy = d["gx"], d["gy"]
            sch = d["scheme"]
            point_item = {
                "x": round(x, 4), "y": round(y, 4),
                "envelope": [round(v, 4) for v in
                             _service_envelope((x, y), sch, gx, gy)],
                "valid": i not in pinned,   # 自由解点必然满足全部约束
            }
            if i in pinned:
                # 拖动固定点：valid 由静态逐约束检查决定
                point_item["valid"] = not pin_violations[i]
                if r is not None and r["point"] is not None:
                    point_item["z"] = r["point"]["z"]
                    point_item["checks"] = r["point"]["checks"]
                    point_item["throw_ratio"] = r["point"]["throw_ratio"]
                    point_item["h_shift_used"] = r["point"]["h_shift_used"]
            else:
                # 自由解点：z 取区间幕布中心高度（前端可再拖动侧视图）
                point_item["z"] = (screen["bottom"] + sh / 2)
            item["point"] = point_item
        else:
            item["point"] = None
        zone_results.append(item)

    return {
        "status": status,
        "joint_feasible": free_solution is not None,
        "pinned_ok": pin_status == "ok",
        "diagnostics": joint_diags,
        "coverage": coverage,
        "zones": zone_results,
    }
