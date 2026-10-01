"""会议室投影机选位工作台 — Flask 后端。"""
from flask import Flask, jsonify, render_template, request

import geometry
from examples import EXAMPLES

app = Flask(__name__)


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/examples")
def api_examples():
    return jsonify(EXAMPLES)


@app.post("/api/compute")
def api_compute():
    data = request.get_json(force=True, silent=False)
    try:
        room = data["room"]
        screen = data["screen"]
        schemes = data.get("schemes", [])
        obstacles = data.get("obstacles", [])
        point = data.get("point")
        lens_height = data.get("lens_height")
        results = [
            geometry.compute_scheme(room, screen, s, obstacles, point, lens_height)
            for s in schemes
        ]
    except (KeyError, TypeError, ValueError) as exc:
        return jsonify({"error": f"参数无效: {exc}"}), 400
    return jsonify({"schemes": results})


@app.post("/api/blend")
def api_blend():
    """多机拼接联合规划。

    入参：room / screen / obstacles 与 /api/compute 相同；
    schemes 为候选镜头方案列表；zones 为 2~3 个有序覆盖区间：
      {name, scheme_id, width, min_overlap, service_x, service_y}
      - width        区间宽度（米），替代整幅幕宽参与投射比计算
      - min_overlap  与左侧相邻区间的最小拼接重叠（米，第 1 区间可省略）
      - service_x/y  机身横向/纵深检修净距（米）
    points / lens_heights 与 zones 等长，元素为 {"x","y"} / 数值或 null。
    """
    data = request.get_json(force=True, silent=False)
    try:
        room = data["room"]
        screen = data["screen"]
        obstacles = data.get("obstacles", [])
        schemes = data.get("schemes", [])
        zones = data["zones"]
        points = data.get("points")
        lens_heights = data.get("lens_heights")
        if not isinstance(zones, list) or not 2 <= len(zones) <= 3:
            raise ValueError("zones 必须是包含 2~3 个覆盖区间的数组")
        schemes_by_id = {s.get("id"): s for s in schemes}
        result = geometry.compute_blend(
            room, screen, schemes_by_id, zones, obstacles,
            points=points, lens_heights=lens_heights)
    except (KeyError, TypeError, ValueError) as exc:
        return jsonify({"error": f"参数无效: {exc}"}), 400
    return jsonify(result)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
