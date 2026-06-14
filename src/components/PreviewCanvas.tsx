import type { MaterialConfig, NestingResult, PieceItem } from "../types";
import { buildResultSvg } from "../lib/exporters";

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
  const usedSheets = result?.usedSheets || 1;
  const exportedPreviewSvg = result ? buildResultSvg(pieces, material, result) : null;

  return (
    <div className="scroll-soft overflow-auto rounded-[24px] border border-line bg-[#f5f8f1] p-5">
      <div className="relative min-h-[320px] min-w-full">
        <svg
          width={(material.width + 60) * usedSheets * scale}
          height={(material.height + 40) * scale}
          viewBox={`0 0 ${(material.width + 60) * usedSheets} ${material.height + 40}`}
          className="absolute inset-0 min-h-[320px] min-w-full"
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
            </g>
          ))}
        </svg>
        {exportedPreviewSvg ? (
          <div
            className="absolute inset-0 [&_polygon]:fill-[#d6f0cf] [&_polyline]:fill-transparent [&_svg]:min-h-[320px] [&_svg]:min-w-full [&_*]:stroke-[#3e8f57] [&_*]:[vector-effect:non-scaling-stroke]"
            style={{
              width: (material.width + 60) * usedSheets * scale,
              height: (material.height + 40) * scale
            }}
            dangerouslySetInnerHTML={{ __html: exportedPreviewSvg }}
          />
        ) : null}
      </div>
    </div>
  );
}
