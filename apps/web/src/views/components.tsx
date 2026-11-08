import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { createLibrary, useStateField, useTriggerAction, type ComponentRenderer } from "@openuidev/react-lang";
import {
  VIEW_ACTIONS,
  VIEW_COMPONENTS,
  VIEW_FUNCTIONS,
  VIEW_ROOT,
  type Badge,
  type BarChart,
  type Button,
  type Callout,
  type Card,
  type Heading,
  type Image,
  type Link,
  type LineChart,
  type List,
  type PropsOf,
  type Select,
  type Stack,
  type Stat,
  type Table,
  type Tabs,
  type Text,
  type Timeline,
  type Toggle,
} from "@aihub/views";
import type { View } from "@aihub/shared";
import { buttonEffect, imageSource, siteOf, webUrl } from "../lib/views.ts";
import { asArray, Chart } from "./charts.tsx";

// How AiHub draws each view component (DESIGN.md › Views). The schemas come from @aihub/views, the
// same ones the daemon checks programs against; only the drawing is here. Programs are checked, but
// values a dashboard's queries fill in are only known at runtime, so every renderer takes what it
// gets and draws what it can.

/** What every component in one view needs to know about it. */
export const ViewContext = createContext<{ outside: View["outside"] }>({ outside: "ask" });

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function toneClass(tone: unknown): string {
  return typeof tone === "string" && ["good", "warn", "bad", "neutral"].includes(tone) ? ` view-tone-${tone}` : "";
}

/** The props of sub-components such as a Table's columns, skipping anything that isn't one. */
function childProps(value: unknown, typeName: string): Array<Record<string, unknown>> {
  return asArray(value)
    .filter((node): node is { typeName: string; props: Record<string, unknown> } => !!node && typeof node === "object" && (node as { typeName?: unknown }).typeName === typeName)
    .map((node) => node.props ?? {});
}

const TextView: ComponentRenderer<PropsOf<typeof Text>> = ({ props }) => (
  <p className={`view-text view-size-${text(props.size) || "normal"}${toneClass(props.tone)}`}>{text(props.text)}</p>
);

const HeadingView: ComponentRenderer<PropsOf<typeof Heading>> = ({ props }) => {
  const level = props.level === 2 || props.level === 3 ? props.level : 1;
  // Views sit inside a message or a panel that has its own heading.
  const Tag = (["h3", "h4", "h5"] as const)[level - 1]!;
  return <Tag className={`view-heading view-heading-${level}`}>{text(props.text)}</Tag>;
};

const BadgeView: ComponentRenderer<PropsOf<typeof Badge>> = ({ props }) => <span className={`view-badge${toneClass(props.tone)}`}>{text(props.text)}</span>;

const CalloutView: ComponentRenderer<PropsOf<typeof Callout>> = ({ props }) => (
  <div className={`view-callout${toneClass(props.tone)}`} role="note">
    {props.title && <p className="view-callout-title">{text(props.title)}</p>}
    <p>{text(props.text)}</p>
  </div>
);

const StatView: ComponentRenderer<PropsOf<typeof Stat>> = ({ props }) => (
  <div className={`view-stat${toneClass(props.tone)}`}>
    <p className="view-stat-label">{text(props.label)}</p>
    <p className="view-stat-value">{text(props.value) || "–"}</p>
    {props.detail && <p className="view-stat-detail">{text(props.detail)}</p>}
  </div>
);

const TableView: ComponentRenderer<PropsOf<typeof Table>> = ({ props }) => {
  const columns = childProps(props.columns, "Col");
  const rows = Math.max(0, ...columns.map((column) => asArray(column.values).length));
  return (
    <div className="view-table-wrap">
      <table className="view-table">
        {props.caption && <caption>{text(props.caption)}</caption>}
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={index} scope="col" className={column.align === "right" ? "num" : undefined}>
                {text(column.label)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, row) => (
            <tr key={row}>
              {columns.map((column, index) => (
                <td key={index} className={column.align === "right" ? "num" : undefined}>
                  {text(asArray(column.values)[row])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows === 0 && <p className="muted small view-empty">Nothing to show.</p>}
    </div>
  );
};

const BarChartView: ComponentRenderer<PropsOf<typeof BarChart>> = ({ props }) => <Chart kind="bar" props={props} />;
const LineChartView: ComponentRenderer<PropsOf<typeof LineChart>> = ({ props }) => <Chart kind="line" props={props} />;

/** A link to an outside page, naming its site. Anything but a web page stays plain text. */
function OutsideLink({ url, children }: { url: unknown; children: ReactNode }) {
  const parsed = webUrl(url);
  if (!parsed) return <>{children}</>;
  return (
    <a className="view-link" href={parsed.href} target="_blank" rel="noopener noreferrer" title={`Opens ${parsed.href} in a new tab`}>
      {children}
      <span className="view-site">{siteOf(parsed)}</span>
    </a>
  );
}

const ListView: ComponentRenderer<PropsOf<typeof List>> = ({ props }) => {
  const items = childProps(props.items, "ListItem");
  const Tag = props.ordered ? "ol" : "ul";
  return (
    <Tag className="view-list">
      {items.map((item, index) => (
        <li key={index} className={`view-list-item${toneClass(item.tone)}`}>
          <div className="view-list-main">
            <p className="view-list-title">{item.url ? <OutsideLink url={item.url}>{text(item.title)}</OutsideLink> : text(item.title)}</p>
            {text(item.detail) && <p className="view-list-detail">{text(item.detail)}</p>}
          </div>
          {text(item.meta) && <span className="view-list-meta">{text(item.meta)}</span>}
        </li>
      ))}
      {items.length === 0 && <li className="muted small">Nothing to show.</li>}
    </Tag>
  );
};

const TimelineView: ComponentRenderer<PropsOf<typeof Timeline>> = ({ props }) => (
  <ol className="view-timeline">
    {childProps(props.events, "TimelineEvent").map((event, index) => (
      <li key={index} className={`view-timeline-event${toneClass(event.tone)}`}>
        <span className="view-timeline-time">{text(event.time)}</span>
        <div>
          <p className="view-timeline-title">{text(event.title)}</p>
          {text(event.detail) && <p className="view-timeline-detail">{text(event.detail)}</p>}
        </div>
      </li>
    ))}
  </ol>
);

const LinkView: ComponentRenderer<PropsOf<typeof Link>> = ({ props }) => (
  <p className="view-text">
    <OutsideLink url={props.url}>{text(props.label)}</OutsideLink>
  </p>
);

/** An outside image loads by itself only where the view allows; otherwise it waits for a click. */
const ImageView: ComponentRenderer<PropsOf<typeof Image>> = ({ props }) => {
  const { outside } = useContext(ViewContext);
  const [shown, setShown] = useState(false);
  const source = imageSource(props.url, outside);
  const alt = text(props.alt);
  const caption = props.caption ? <figcaption>{text(props.caption)}</figcaption> : null;
  if (source.kind === "blocked") {
    return (
      <figure className="view-image view-image-placeholder">
        <p>
          {alt || "An image"} <span className="muted">· {source.reason}, so it isn't shown</span>
        </p>
        {caption}
      </figure>
    );
  }
  if (source.kind === "ask" && !shown) {
    return (
      <figure className="view-image view-image-placeholder">
        <button type="button" className="view-image-ask" onClick={() => setShown(true)} title={`Loads ${source.src}. ${source.site} sees that you looked.`}>
          <span>{alt || "An image"}</span>
          <span className="view-site">Show image from {source.site}</span>
        </button>
        {caption}
      </figure>
    );
  }
  return (
    <figure className="view-image">
      <img src={source.src} alt={alt} loading="lazy" referrerPolicy="no-referrer" />
      {caption}
    </figure>
  );
};

/** A button does what it says: its tooltip reads the action, and a site it opens shows on it. */
const ButtonView: ComponentRenderer<PropsOf<typeof Button>> = ({ props }) => {
  const trigger = useTriggerAction();
  const label = text(props.label) || "Go";
  const effect = buttonEffect(label, props.action);
  return (
    <button
      type="button"
      className={`view-button${props.variant === "secondary" ? " secondary" : ""}`}
      title={effect.says}
      onClick={() => void trigger(label, undefined, props.action as Parameters<typeof trigger>[2])}
    >
      {label}
      {effect.opens && <span className="view-site">↗ {effect.opens}</span>}
    </button>
  );
};

const SelectView: ComponentRenderer<PropsOf<typeof Select>> = ({ props }) => {
  const field = useStateField("value", props.value);
  const id = useId();
  const options = asArray(props.options).map(text);
  const value = text(field.value);
  return (
    <label className="view-field" htmlFor={id}>
      {props.label && <span>{text(props.label)}</span>}
      <select id={id} value={value} onChange={(event) => field.setValue(event.target.value as never)}>
        {!options.includes(value) && <option value={value}>{value || "–"}</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
};

const ToggleView: ComponentRenderer<PropsOf<typeof Toggle>> = ({ props }) => {
  const field = useStateField("value", props.value);
  return (
    <label className="view-field view-toggle">
      <input type="checkbox" role="switch" checked={field.value === true} onChange={(event) => field.setValue(event.target.checked as never)} />
      <span>{text(props.label)}</span>
    </label>
  );
};

const StackView: ComponentRenderer<PropsOf<typeof Stack>> = ({ props, renderNode }) => (
  <div className={`view-stack view-${props.direction === "row" ? "row" : "column"} view-gap-${text(props.gap) || "normal"}`}>{renderNode(props.children)}</div>
);

const CardView: ComponentRenderer<PropsOf<typeof Card>> = ({ props, renderNode }) => (
  <section className="view-card">
    <header>
      <h4 className="view-card-title">{text(props.title)}</h4>
      {props.detail && <p className="view-card-detail">{text(props.detail)}</p>}
    </header>
    <div className="view-stack view-column view-gap-normal">{renderNode(props.children)}</div>
  </section>
);

const TabsView: ComponentRenderer<PropsOf<typeof Tabs>> = ({ props, renderNode }) => {
  const tabs = childProps(props.tabs, "Tab");
  const [current, setCurrent] = useState(0);
  const id = useId();
  const shown = Math.min(current, Math.max(0, tabs.length - 1));
  return (
    <div className="view-tabs">
      <div role="tablist" className="view-tablist">
        {tabs.map((tab, index) => (
          <button
            key={index}
            type="button"
            role="tab"
            id={`${id}-tab-${index}`}
            aria-selected={index === shown}
            aria-controls={`${id}-panel`}
            onClick={() => setCurrent(index)}
          >
            {text(tab.label)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${shown}`} className="view-stack view-column view-gap-normal">
        {tabs[shown] ? renderNode(tabs[shown].children) : null}
      </div>
    </div>
  );
};

/** Parts drawn by their parents, such as a Table's columns. On their own they draw nothing. */
const Part: ComponentRenderer = () => null;

// Each renderer takes its own component's props.
const RENDERERS: Record<string, ComponentRenderer<any>> = {
  Text: TextView,
  Heading: HeadingView,
  Badge: BadgeView,
  Callout: CalloutView,
  Stat: StatView,
  Table: TableView,
  BarChart: BarChartView,
  LineChart: LineChartView,
  List: ListView,
  Timeline: TimelineView,
  Link: LinkView,
  Image: ImageView,
  Button: ButtonView,
  Select: SelectView,
  Toggle: ToggleView,
  Stack: StackView,
  Card: CardView,
  Tabs: TabsView,
};

/** The view library with AiHub's renderers: the same components, actions and functions the daemon checks against. */
export const viewRenderLibrary = createLibrary({
  components: VIEW_COMPONENTS.map((component) => ({ ...component, component: RENDERERS[component.name] ?? Part })),
  actions: VIEW_ACTIONS,
  functions: VIEW_FUNCTIONS,
  root: VIEW_ROOT,
  id: "aihub",
});

