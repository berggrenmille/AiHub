import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { BarChart, PropsOf } from "@aihub/views";
import { formatNumber, niceTicks } from "../lib/views.ts";

// The charts views draw (DESIGN.md › Views). Thin marks on a quiet grid, one axis, a legend once there
// are two series, values on hover or keyboard focus, and a table view a click away, so no number is
// reachable only through color or the pointer. Series colors come from the --series-* tokens, in a
// fixed order validated for color vision deficiency on both themes.

type ChartProps = PropsOf<typeof BarChart>;

interface Series {
  name: string;
  values: Array<number | null>;
  color: string;
}

const HEIGHT = 200;
const MARGIN = { top: 14, right: 10, bottom: 24 };
const BAR_MAX = 24;
const GAP = 2;
const FONT = 11;

export function Chart({ kind, props }: { kind: "bar" | "line"; props: ChartProps }) {
  const labels = asArray(props.labels).map((label) => String(label ?? ""));
  const series = seriesOf(props.series, labels.length);
  const highlight = new Set(asArray(props.highlight).map(String));
  const [table, setTable] = useState(false);
  const title = typeof props.title === "string" ? props.title : null;
  const unit = typeof props.unit === "string" ? props.unit : null;

  return (
    <figure className="view-chart">
      <figcaption className="view-chart-head">
        <span className="view-chart-title">
          {title ?? (series.length === 1 ? series[0]!.name : "")}
          {unit && <span className="muted"> · {unit}</span>}
        </span>
        <button type="button" className="view-chart-toggle" aria-pressed={table} onClick={() => setTable((shown) => !shown)}>
          {table ? "Chart" : "Table"}
        </button>
      </figcaption>
      {series.length > 1 && (
        <ul className="view-legend" aria-label="Series">
          {series.map((one) => (
            <li key={one.name}>
              <span className={`view-key view-key-${kind}`} style={{ background: one.color }} aria-hidden="true" />
              {one.name}
            </li>
          ))}
        </ul>
      )}
      {labels.length === 0 || series.length === 0 ? (
        <p className="muted small">Nothing to chart.</p>
      ) : table ? (
        <ChartTable labels={labels} series={series} unit={unit} />
      ) : (
        <Plot kind={kind} labels={labels} series={series} highlight={highlight} unit={unit} label={title ?? "Chart"} />
      )}
    </figure>
  );
}

function Plot(props: { kind: "bar" | "line"; labels: string[]; series: Series[]; highlight: Set<string>; unit: string | null; label: string }) {
  const { kind, labels, series, highlight } = props;
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const [active, setActive] = useState<number | null>(null);

  const values = series.flatMap((one) => one.values.filter((value): value is number => value !== null));
  const ticks = niceTicks(values);
  const low = ticks[0]!;
  const high = ticks.at(-1)!;
  const left = Math.max(...ticks.map((tick) => formatNumber(tick).length)) * 6.5 + 10;
  const plotWidth = Math.max(40, width - left - MARGIN.right);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const band = plotWidth / labels.length;
  const y = (value: number) => MARGIN.top + plotHeight - ((value - low) / (high - low || 1)) * plotHeight;
  const xCenter = (index: number) => left + band * index + band / 2;
  const zero = y(Math.max(low, Math.min(0, high)));
  // Every nth label, so they never overlap.
  const widest = Math.max(...labels.map((label) => label.length)) * 6.2 + 8;
  const every = Math.max(1, Math.ceil(widest / band));
  const faded = (index: number) => highlight.size > 0 && !highlight.has(labels[index]!);
  // A single series names its highlighted values, but only when every one fits beside its
  // neighbors; otherwise none do, and the tooltip and the table carry them.
  const valueLabels =
    series.length === 1
      ? series[0]!.values.flatMap((value, index) => (value !== null && highlight.has(labels[index]!) ? [{ index, value, text: formatNumber(value) }] : []))
      : [];
  const labelsFit = valueLabels.every((one, n) => {
    const next = valueLabels[n + 1];
    const ownWidth = one.text.length * 6.2;
    if (ownWidth > width - left) return false;
    return !next || (next.index - one.index) * band >= (ownWidth + next.text.length * 6.2) / 2 + 4;
  });

  const indexAt = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return null;
    const index = Math.floor((clientX - rect.left - left) / band);
    return index >= 0 && index < labels.length ? index : null;
  };
  const onPointerMove = (event: PointerEvent) => setActive(indexAt(event.clientX));
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    setActive((current) => Math.min(labels.length - 1, Math.max(0, (current ?? (step > 0 ? -1 : labels.length)) + step)));
  };

  const groupWidth = Math.min(band - 6, series.length * BAR_MAX + (series.length - 1) * GAP);
  const barWidth = Math.max(1, (groupWidth - (series.length - 1) * GAP) / series.length);

  return (
    <div className="view-plot" ref={box} onPointerMove={onPointerMove} onPointerLeave={() => setActive(null)}>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`${props.label}: ${kind} chart of ${series.map((one) => one.name).join(", ")} over ${labels.length} points. Use the arrow keys to read values, or open the table.`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((current) => current ?? 0)}
        onBlur={() => setActive(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line className={tick === 0 ? "view-axis" : "view-grid"} x1={left} x2={left + plotWidth} y1={y(tick)} y2={y(tick)} />
            <text className="view-tick" x={left - 6} y={y(tick)} dy="0.32em" textAnchor="end" fontSize={FONT}>
              {formatNumber(tick)}
            </text>
          </g>
        ))}
        {labels.map((label, index) =>
          index % every === 0 ? (
            <text key={index} className="view-tick" x={xCenter(index)} y={HEIGHT - 6} textAnchor="middle" fontSize={FONT}>
              {label}
            </text>
          ) : null,
        )}
        {kind === "bar" && active !== null && <rect className="view-hover-band" x={left + band * active} y={MARGIN.top} width={band} height={plotHeight} />}
        {kind === "bar"
          ? series.map((one, s) =>
              one.values.map((value, index) =>
                value === null ? null : (
                  <path
                    key={`${s}-${index}`}
                    d={barPath(xCenter(index) - groupWidth / 2 + s * (barWidth + GAP), barWidth, zero, y(value))}
                    fill={one.color}
                    opacity={faded(index) ? 0.4 : 1}
                  />
                ),
              ),
            )
          : series.map((one, s) => (
              <g key={s}>
                {series.length === 1 && <path d={areaPath(one.values, xCenter, y, zero)} fill={one.color} opacity={0.1} />}
                <path d={linePath(one.values, xCenter, y)} fill="none" stroke={one.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {one.values.map((value, index) =>
                  value !== null && (highlight.has(labels[index]!) || index === lastIndex(one.values) || index === active) ? (
                    <circle key={index} className="view-dot" cx={xCenter(index)} cy={y(value)} r={4} fill={one.color} />
                  ) : null,
                )}
              </g>
            ))}
        {kind === "line" && active !== null && <line className="view-crosshair" x1={xCenter(active)} x2={xCenter(active)} y1={MARGIN.top} y2={MARGIN.top + plotHeight} />}
        {labelsFit &&
          valueLabels.map(({ index, value, text }) => (
            <text key={index} className="view-value" x={xCenter(index)} y={Math.min(y(value), zero) - 6} textAnchor="middle" fontSize={FONT}>
              {text}
            </text>
          ))}
      </svg>
      {active !== null && (
        <div className="view-tooltip" style={{ left: Math.min(Math.max(xCenter(active), 70), width - 70) }} role="status">
          <p className="view-tooltip-label">{labels[active]}</p>
          {series.map((one) => (
            <p key={one.name} className="view-tooltip-row">
              <span className="view-tooltip-key" style={{ background: one.color }} aria-hidden="true" />
              <strong>{one.values[active] === null || one.values[active] === undefined ? "–" : formatNumber(one.values[active]!)}</strong>
              {props.unit && <span className="muted"> {props.unit}</span>}
              {series.length > 1 && <span className="muted"> {one.name}</span>}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function ChartTable({ labels, series, unit }: { labels: string[]; series: Series[]; unit: string | null }) {
  return (
    <div className="view-table-wrap">
      <table className="view-table">
        <thead>
          <tr>
            <th scope="col" />
            {series.map((one) => (
              <th key={one.name} scope="col" className="num">
                {one.name}
                {unit ? ` (${unit})` : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((label, index) => (
            <tr key={index}>
              <th scope="row">{label}</th>
              {series.map((one) => (
                <td key={one.name} className="num">
                  {one.values[index] === null || one.values[index] === undefined ? "–" : formatNumber(one.values[index]!)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TONE_COLORS: Record<string, string> = {
  good: "var(--status-good)",
  warn: "var(--status-warn)",
  bad: "var(--status-bad)",
  neutral: "var(--status-neutral)",
};

/** Series from the program, each as long as the labels. Colors go in fixed order unless a tone says otherwise. */
function seriesOf(raw: unknown, length: number): Series[] {
  return asArray(raw)
    .map((node) => (node && typeof node === "object" && "props" in node ? (node as { props: Record<string, unknown> }).props : null))
    .filter((props): props is Record<string, unknown> => props !== null)
    .slice(0, 8)
    .map((props, index) => ({
      name: typeof props.name === "string" ? props.name : `Series ${index + 1}`,
      values: Array.from({ length }, (_, at) => {
        const value = asArray(props.values)[at];
        return typeof value === "number" && Number.isFinite(value) ? value : null;
      }),
      color: (typeof props.tone === "string" && TONE_COLORS[props.tone]) || `var(--series-${index + 1})`,
    }));
}

/** A bar with a rounded data end and a square base, growing up or down from the baseline. */
function barPath(x: number, width: number, base: number, top: number): string {
  const height = Math.abs(base - top);
  const radius = Math.min(4, width / 2, height);
  if (top <= base) {
    return `M${x},${base}V${top + radius}Q${x},${top} ${x + radius},${top}H${x + width - radius}Q${x + width},${top} ${x + width},${top + radius}V${base}Z`;
  }
  return `M${x},${base}V${top - radius}Q${x},${top} ${x + radius},${top}H${x + width - radius}Q${x + width},${top} ${x + width},${top - radius}V${base}Z`;
}

/** A line through the values, broken where one is missing. */
function linePath(values: Array<number | null>, x: (index: number) => number, y: (value: number) => number): string {
  let path = "";
  let drawing = false;
  values.forEach((value, index) => {
    if (value === null) {
      drawing = false;
      return;
    }
    path += `${drawing ? "L" : "M"}${x(index)},${y(value)}`;
    drawing = true;
  });
  return path;
}

function areaPath(values: Array<number | null>, x: (index: number) => number, y: (value: number) => number, base: number): string {
  const points = values.map((value, index) => (value === null ? null : ([x(index), y(value)] as const))).filter((point) => point !== null);
  if (points.length < 2) return "";
  return `M${points[0]![0]},${base}${points.map(([px, py]) => `L${px},${py}`).join("")}L${points.at(-1)![0]},${base}Z`;
}

function lastIndex(values: Array<number | null>): number {
  for (let index = values.length - 1; index >= 0; index--) if (values[index] !== null) return index;
  return -1;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The width of an element, kept current as it resizes. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(360);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth || 360);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width) || 360);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
