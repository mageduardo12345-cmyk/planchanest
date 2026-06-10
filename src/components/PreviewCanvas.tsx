import type { MaterialConfig, NestingResult, PieceItem } from "../types";
import { normalizeSvgMarkup } from "../lib/geometry";

function pieceLookup(pieces: PieceItem[], pieceId: string) {
  return pieces.find((piece) => piece.id === pieceId);
}

export default function PreviewCanvas({
  pieces,
  material,
  result
}: {
  pieces: PieceItem[];
  material: MaterialConfig;
  result: NestingResult | null;
}) {
  const scale = 480 / Math.max(material.width, material.height);
  const placements = result?.placements ?? [];
  const usedSheets = result?.usedSheets || 1;

  return (
    <div className="scroll-soft overflow-auto rounded-[24px] border border-line bg-[#f5f8f1] p-5">
      <svg
        width={(material.width + 60) * usedSheets * scale}
        height={(material.height + 40) * scale}
        viewBox={`0 0 ${(material.width + 60) * usedSheets} ${material.height + 40}`}
        className="min-h-[320px] min-w-full"
      >
        <rect width="100%" height="100%" fill="#eef2ea" />
        {Array.from({ length: usedSheets }).map((_, sheetIndex) => (
          <g key={sheetIndex} transform={`translate(${sheetIndex * (material.width + 60) + 20} 20)`}>
            <rect
              x={0}
              y={0}
              width={material.width}
              height={material.height}
              rx={14}
              fill="#ffffff"
              stroke="#aab5a1"
              strokeWidth={3}
            />
            <text x={20} y={30} fontSize={18} fill="#4f5b49">
              Placa {sheetIndex + 1}
            </text>
            {placements
              .filter((placement) => placement.sheetIndex === sheetIndex)
              .map((placement, placementIndex) => {
                const piece = pieceLookup(pieces, placement.pieceId);
                if (!piece) {
                  return null;
                }

                const markup = normalizeSvgMarkup(piece.geometry.svgMarkup, piece.geometry.sourceBounds);
                return (
                  <g
                    key={`${placement.pieceId}-${placementIndex}`}
                    transform={`translate(${placement.x} ${placement.y}) rotate(${placement.rotation})`}
                    className="[&_circle]:fill-[#d6f0cf] [&_ellipse]:fill-[#d6f0cf] [&_path]:fill-[#d6f0cf] [&_polygon]:fill-[#d6f0cf] [&_polyline]:fill-transparent [&_rect]:fill-[#d6f0cf] [&_*]:stroke-[#3e8f57] [&_*]:[vector-effect:non-scaling-stroke]"
                  >
                    <g dangerouslySetInnerHTML={{ __html: markup }} />
                  </g>
                );
              })}
          </g>
        ))}
      </svg>
    </div>
  );
}
