import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, "dist");
const indexPath = path.join(distDir, "index.html");
const port = Number(process.env.PORT || 3000);

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(data));
}

function sendText(response, status, text, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": contentType
  });
  response.end(text);
}

function getMimeType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

async function readBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) {
      throw new Error("La solicitud excede el tamano permitido.");
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function dxfPair(code, value) {
  return `${code}\n${value}\n`;
}

function getSceneMetrics(material, result) {
  const usedSheets = result.usedSheets || 1;
  return {
    sceneWidth: material.width + Math.max(usedSheets - 1, 0) * (material.width + 40),
    sceneHeight: material.height
  };
}

function getSheetOffset(material, sheetIndex) {
  return sheetIndex * (material.width + 40);
}

function rotatePoint(point, angleDeg) {
  const angle = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos
  };
}

function transformPoint(point, translation, rotationDeg) {
  const rotated = rotatePoint(point, rotationDeg);
  return {
    x: rotated.x + translation.x,
    y: rotated.y + translation.y
  };
}

function toDxfY(sceneHeight, y) {
  return sceneHeight - y;
}

function normalizeArcSweep(startAngle, endAngle) {
  let sweep = endAngle - startAngle;
  while (sweep <= 0) {
    sweep += Math.PI * 2;
  }
  return sweep;
}

function sampleEllipse(cx, cy, rx, ry, rotation = 0, segments = 96) {
  const points = [];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  for (let index = 0; index <= segments; index += 1) {
    const angle = (Math.PI * 2 * index) / segments;
    const localX = rx * Math.cos(angle);
    const localY = ry * Math.sin(angle);
    points.push({
      x: cx + localX * cos - localY * sin,
      y: cy + localX * sin + localY * cos
    });
  }

  return points;
}

function sampleArc(entity, segments = 64) {
  const sweep = normalizeArcSweep(entity.startAngle, entity.endAngle);
  const points = [];

  for (let index = 0; index <= segments; index += 1) {
    const angle = entity.startAngle + sweep * (index / segments);
    points.push({
      x: entity.cx + entity.r * Math.cos(angle),
      y: entity.cy - entity.r * Math.sin(angle)
    });
  }

  return points;
}

function sampleEllipseArc(entity, segments = 72) {
  let sweep = entity.endAngle - entity.startAngle;
  while (sweep <= 0) {
    sweep += Math.PI * 2;
  }

  const points = [];
  const cos = Math.cos(entity.rotation);
  const sin = Math.sin(entity.rotation);
  for (let index = 0; index <= segments; index += 1) {
    const angle = entity.startAngle + sweep * (index / segments);
    const localX = entity.rx * Math.cos(angle);
    const localY = entity.ry * Math.sin(angle);
    points.push({
      x: entity.cx + localX * cos - localY * sin,
      y: entity.cy + localX * sin + localY * cos
    });
  }

  return points;
}

function vectorAngle(ux, uy, vx, vy) {
  const dot = ux * vx + uy * vy;
  const lengths = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  const safe = lengths ? Math.max(-1, Math.min(1, dot / lengths)) : 1;
  const angle = Math.acos(safe);
  return ux * vy - uy * vx < 0 ? -angle : angle;
}

function svgArcToCenter(start, end, rx, ry, rotationDeg, largeArc, sweep) {
  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (start.x - end.x) / 2;
  const dy = (start.y - end.y) / 2;
  const x1Prime = cosPhi * dx + sinPhi * dy;
  const y1Prime = -sinPhi * dx + cosPhi * dy;

  let adjustedRx = Math.abs(rx);
  let adjustedRy = Math.abs(ry);
  if (adjustedRx < 0.000001 || adjustedRy < 0.000001) {
    return null;
  }

  const lambda =
    x1Prime * x1Prime / (adjustedRx * adjustedRx) +
    y1Prime * y1Prime / (adjustedRy * adjustedRy);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    adjustedRx *= scale;
    adjustedRy *= scale;
  }

  const numerator =
    adjustedRx * adjustedRx * adjustedRy * adjustedRy -
    adjustedRx * adjustedRx * y1Prime * y1Prime -
    adjustedRy * adjustedRy * x1Prime * x1Prime;
  const denominator =
    adjustedRx * adjustedRx * y1Prime * y1Prime +
    adjustedRy * adjustedRy * x1Prime * x1Prime;
  const factorBase = denominator === 0 ? 0 : Math.max(0, numerator / denominator);
  const factor = (largeArc === sweep ? -1 : 1) * Math.sqrt(factorBase);
  const cxPrime = factor * ((adjustedRx * y1Prime) / adjustedRy);
  const cyPrime = factor * ((-adjustedRy * x1Prime) / adjustedRx);

  const cx = cosPhi * cxPrime - sinPhi * cyPrime + (start.x + end.x) / 2;
  const cy = sinPhi * cxPrime + cosPhi * cyPrime + (start.y + end.y) / 2;
  const theta1 = vectorAngle(1, 0, (x1Prime - cxPrime) / adjustedRx, (y1Prime - cyPrime) / adjustedRy);
  let deltaTheta = vectorAngle(
    (x1Prime - cxPrime) / adjustedRx,
    (y1Prime - cyPrime) / adjustedRy,
    (-x1Prime - cxPrime) / adjustedRx,
    (-y1Prime - cyPrime) / adjustedRy
  );

  if (!sweep && deltaTheta > 0) {
    deltaTheta -= Math.PI * 2;
  }
  if (sweep && deltaTheta < 0) {
    deltaTheta += Math.PI * 2;
  }

  return { cx, cy, rx: adjustedRx, ry: adjustedRy, theta1, deltaTheta };
}

function parseSvgPath(pathData, offsetX = 0, offsetY = 0) {
  const tokens = pathData.match(/[MLHVAZmlhvaz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g);
  if (!tokens?.length) {
    return [];
  }

  const polylines = [];
  let index = 0;
  let current = { x: 0, y: 0 };
  let start = null;
  let active = [];

  const pushPoint = (point) => {
    current = point;
    active.push({ x: point.x - offsetX, y: point.y - offsetY });
  };

  const flush = (closed = false) => {
    if (!active.length) {
      return;
    }
    if (closed && active.length > 1) {
      const first = active[0];
      const last = active[active.length - 1];
      if (Math.abs(first.x - last.x) > 0.001 || Math.abs(first.y - last.y) > 0.001) {
        active.push({ ...first });
      }
    }
    polylines.push({ points: active, closed });
    active = [];
  };

  while (index < tokens.length) {
    const command = tokens[index++];

    if (command === "M" || command === "m") {
      flush(false);
      const x = Number(tokens[index++]);
      const y = Number(tokens[index++]);
      const point = command === "m" ? { x: current.x + x, y: current.y + y } : { x, y };
      start = point;
      pushPoint(point);
      continue;
    }

    if (command === "L" || command === "l") {
      const x = Number(tokens[index++]);
      const y = Number(tokens[index++]);
      pushPoint(command === "l" ? { x: current.x + x, y: current.y + y } : { x, y });
      continue;
    }

    if (command === "H" || command === "h") {
      const x = Number(tokens[index++]);
      pushPoint(command === "h" ? { x: current.x + x, y: current.y } : { x, y: current.y });
      continue;
    }

    if (command === "V" || command === "v") {
      const y = Number(tokens[index++]);
      pushPoint(command === "v" ? { x: current.x, y: current.y + y } : { x: current.x, y });
      continue;
    }

    if (command === "A" || command === "a") {
      const rx = Number(tokens[index++]);
      const ry = Number(tokens[index++]);
      const rotation = Number(tokens[index++]);
      const largeArc = Number(tokens[index++]);
      const sweep = Number(tokens[index++]);
      const x = Number(tokens[index++]);
      const y = Number(tokens[index++]);
      const endPoint = command === "a" ? { x: current.x + x, y: current.y + y } : { x, y };
      const arc = svgArcToCenter(current, endPoint, rx, ry, rotation, Boolean(largeArc), Boolean(sweep));
      if (!arc) {
        pushPoint(endPoint);
        continue;
      }

      const segments = Math.max(16, Math.ceil(Math.abs(arc.deltaTheta) / (Math.PI / 18)));
      for (let step = 1; step <= segments; step += 1) {
        const angle = arc.theta1 + arc.deltaTheta * (step / segments);
        const px = arc.cx + arc.rx * Math.cos(rotation * Math.PI / 180) * Math.cos(angle) -
          arc.ry * Math.sin(rotation * Math.PI / 180) * Math.sin(angle);
        const py = arc.cy + arc.rx * Math.sin(rotation * Math.PI / 180) * Math.cos(angle) +
          arc.ry * Math.cos(rotation * Math.PI / 180) * Math.sin(angle);
        pushPoint({ x: px, y: py });
      }
      current = endPoint;
      continue;
    }

    if (command === "Z" || command === "z") {
      if (start) {
        flush(true);
        current = start;
      }
    }
  }

  flush(false);
  return polylines;
}

function buildLineEntity(start, end, sceneHeight) {
  return [
    dxfPair(0, "LINE"),
    dxfPair(8, 0),
    dxfPair(10, start.x.toFixed(4)),
    dxfPair(20, toDxfY(sceneHeight, start.y).toFixed(4)),
    dxfPair(30, 0),
    dxfPair(11, end.x.toFixed(4)),
    dxfPair(21, toDxfY(sceneHeight, end.y).toFixed(4)),
    dxfPair(31, 0)
  ].join("");
}

function buildCircleEntity(entity, translation, rotationDeg, sceneHeight) {
  const center = transformPoint({ x: entity.cx, y: entity.cy }, translation, rotationDeg);
  return [
    dxfPair(0, "CIRCLE"),
    dxfPair(8, 0),
    dxfPair(10, center.x.toFixed(4)),
    dxfPair(20, toDxfY(sceneHeight, center.y).toFixed(4)),
    dxfPair(30, 0),
    dxfPair(40, entity.r.toFixed(4))
  ].join("");
}

function buildArcEntity(entity, translation, rotationDeg, sceneHeight) {
  const center = transformPoint({ x: entity.cx, y: entity.cy }, translation, rotationDeg);
  const startAngleDeg = ((entity.startAngle * 180) / Math.PI + rotationDeg + 360) % 360;
  const endAngleDeg = ((entity.endAngle * 180) / Math.PI + rotationDeg + 360) % 360;

  return [
    dxfPair(0, "ARC"),
    dxfPair(8, 0),
    dxfPair(10, center.x.toFixed(4)),
    dxfPair(20, toDxfY(sceneHeight, center.y).toFixed(4)),
    dxfPair(30, 0),
    dxfPair(40, entity.r.toFixed(4)),
    dxfPair(50, startAngleDeg.toFixed(4)),
    dxfPair(51, endAngleDeg.toFixed(4))
  ].join("");
}

function polylineToLines(points, closed, sceneHeight) {
  const entities = [];
  if (points.length < 2) {
    return entities;
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    entities.push(buildLineEntity(points[index], points[index + 1], sceneHeight));
  }

  if (closed) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.abs(first.x - last.x) > 0.001 || Math.abs(first.y - last.y) > 0.001) {
      entities.push(buildLineEntity(last, first, sceneHeight));
    }
  }

  return entities;
}

function getEntityPolylines(piece, entity) {
  const offsetX = piece.geometry.sourceBounds.minX;
  const offsetY = piece.geometry.sourceBounds.minY;

  if (entity.kind === "polyline") {
    return [{ points: entity.points, closed: entity.closed }];
  }
  if (entity.kind === "ellipse") {
    return [{ points: sampleEllipse(entity.cx, entity.cy, entity.rx, entity.ry, entity.rotation, 96), closed: true }];
  }
  if (entity.kind === "ellipseArc") {
    return [{ points: sampleEllipseArc(entity, 72), closed: false }];
  }
  if (entity.kind === "arc") {
    return [{ points: sampleArc(entity, 64), closed: false }];
  }
  if (entity.kind === "path") {
    return parseSvgPath(entity.d, offsetX, offsetY);
  }
  return [];
}

function getInsUnits(unit) {
  if (unit === "cm") return 5;
  if (unit === "in") return 1;
  return 4;
}

function buildSimpleDxfFromContours(material, usedSheets, contours) {
  const { sceneWidth, sceneHeight } = getSceneMetrics(material, { usedSheets });
  const entities = [];

  for (const contour of contours || []) {
    const validPoints = (contour.points || []).filter(
      (point) => Number.isFinite(point?.x) && Number.isFinite(point?.y)
    );
    if (validPoints.length < 2) {
      continue;
    }

    entities.push(...polylineToLines(validPoints, Boolean(contour.closed), sceneHeight));
  }

  return [
    dxfPair(0, "SECTION"),
    dxfPair(2, "HEADER"),
    dxfPair(9, "$ACADVER"),
    dxfPair(1, "AC1009"),
    dxfPair(9, "$INSUNITS"),
    dxfPair(70, getInsUnits(material.unit)),
    dxfPair(9, "$EXTMIN"),
    dxfPair(10, 0),
    dxfPair(20, 0),
    dxfPair(30, 0),
    dxfPair(9, "$EXTMAX"),
    dxfPair(10, sceneWidth.toFixed(4)),
    dxfPair(20, sceneHeight.toFixed(4)),
    dxfPair(30, 0),
    dxfPair(0, "ENDSEC"),
    dxfPair(0, "SECTION"),
    dxfPair(2, "ENTITIES"),
    entities.join(""),
    dxfPair(0, "ENDSEC"),
    dxfPair(0, "EOF")
  ].join("");
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
      });
      response.end();
      return;
    }

    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(requestUrl.pathname);

    if (pathname === "/api/health") {
      sendJson(response, 200, { ok: true, service: "planchanest-api" });
      return;
    }

    if (pathname === "/api/export/dxf" && request.method === "POST") {
      const body = await readBody(request);
      const dxf = buildSimpleDxfFromContours(
        body.material || { width: 0, height: 0, unit: "mm" },
        body.usedSheets || 1,
        body.contours || []
      );
      sendText(response, 200, dxf, "application/dxf; charset=utf-8");
      return;
    }

    const requestedPath = pathname === "/" ? indexPath : path.join(distDir, pathname);
    const safePath = path.normalize(requestedPath);
    if (!safePath.startsWith(distDir)) {
      sendJson(response, 403, { ok: false, error: "Ruta no permitida." });
      return;
    }

    const filePath = existsSync(safePath) ? safePath : indexPath;
    if (!existsSync(filePath)) {
      sendJson(response, 404, {
        ok: false,
        error: "No existe la carpeta dist. Ejecuta primero el build."
      });
      return;
    }

    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Content-Type": getMimeType(filePath)
    });

    createReadStream(filePath).pipe(response);
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Error interno del servidor."
    });
  }
});

server.listen(port, () => {
  console.log(`PlanchaNest listo en http://localhost:${port}`);
});
