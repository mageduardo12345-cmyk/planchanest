# PlanchaNest

Aplicacion web para importar piezas 2D, configurar material y generar un nesting heuristico desde el navegador.

## Ejecutar

```bash
npm install
npm run dev
```

Si prefieres `pnpm`:

```bash
pnpm install
pnpm dev
```

## Flujo incluido

1. Carga de archivos `SVG`, `DXF` y aviso para `DWG`
2. Deteccion de piezas cerradas y advertencias basicas
3. Edicion de cantidad, nombre, activacion y eliminacion de piezas
4. Configuracion de material, margenes, kerf, rotaciones y calidad
5. Nesting heuristico local con multiples placas
6. Vista previa, metricas y descarga en `SVG` y `PDF`

## Alcance tecnico actual

- `SVG`: soporte local funcional
- `DXF`: soporte local funcional con compatibilidad parcial segun entidad
- `DWG`: no se parsea directamente en esta version; se recomienda convertir a `DXF`
- algoritmo: heuristica `shelf / bottom-left` basada en cajas de contencion, preparada para evolucionar a nesting poligonal mas preciso
- exportacion `SVG`: util para mantener una salida vectorial local
- exportacion `PDF`: reporte visual del acomodo

## Estructura

- `src/lib/importers.ts`: carga y parseo de archivos
- `src/lib/geometry.ts`: normalizacion geometrica y bounds
- `src/lib/nesting.ts`: algoritmo de acomodo
- `src/lib/exporters.ts`: exportaciones
- `src/state/useProjectStore.ts`: estado persistido
- `src/App.tsx`: interfaz principal

## Siguientes pasos recomendados

- reemplazar bounding boxes por colision poligonal real
- mejorar importacion `DXF` para splines, bloques y arcos complejos
- agregar exportacion `DXF` valida desde el layout final
- permitir nesting dentro de huecos
- agregar cancelacion real del calculo con `Web Worker`
