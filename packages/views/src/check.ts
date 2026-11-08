import { createParser, type ASTNode, type ParseResult } from "@openuidev/lang-core";
import { DATA_TOOLS, isDataTool, type DataToolName } from "./data.ts";
import { viewLibrary, VIEW_ROOT } from "./library.ts";

// The daemon checks every view a staff member hands in (DESIGN.md › Views), and answers with what
// to fix, so the staff member corrects it in the same turn. Only views that pass are kept.

/** The longest program AiHub keeps. A view is meant to be small. */
export const VIEW_PROGRAM_LIMIT = 20_000;

export interface ViewCheck {
  /** What makes the program unusable. Empty means it passed. */
  problems: string[];
  /** What the staff member should know but doesn't stop the view, such as a part nothing shows. */
  notes: string[];
}

let parser: ReturnType<typeof createParser> | null = null;

export function parseView(program: string): ParseResult {
  parser ??= createParser(viewLibrary.toJSONSchema(), VIEW_ROOT);
  return parser.parse(program);
}

/**
 * Checks a program against AiHub's components. A view in a reply or briefing (`fetches: false`)
 * holds its data; a dashboard may fetch with the data tools. Nothing may run a Mutation.
 */
export function checkView(program: string, { fetches }: { fetches: boolean }): ViewCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  if (!program.trim()) return { problems: ["The program is empty."], notes };
  if (program.length > VIEW_PROGRAM_LIMIT) return { problems: [`The program is ${program.length} characters; a view may have at most ${VIEW_PROGRAM_LIMIT}. Show less.`], notes };

  let result: ParseResult;
  try {
    result = parseView(program);
  } catch (error) {
    return { problems: [`The program couldn't be read: ${error instanceof Error ? error.message : String(error)}`], notes };
  }
  const { meta } = result;
  if (meta.incomplete) problems.push("The program is cut off: a string, bracket, or call isn't closed.");
  if (!result.root && !result.rootExpression) problems.push(`There is no root. Start with root = ${VIEW_ROOT}([...]).`);
  if (meta.unresolved.length) problems.push(`Used but never defined: ${meta.unresolved.join(", ")}.`);
  for (const error of meta.errors) {
    const where = error.statementId ? `${error.statementId}: ` : "";
    (error.severity === "warning" ? notes : problems).push(`${where}${error.message}`);
  }
  if (meta.orphaned.length) notes.push(`Defined but not shown, so left out: ${meta.orphaned.join(", ")}.`);

  for (const query of result.queryStatements) {
    if (!fetches) {
      problems.push(`${query.statementId}: a view in a reply or briefing can't fetch data. Write the data into the program instead of using Query().`);
      continue;
    }
    const tool = literal(query.toolAST);
    if (tool === null) problems.push(`${query.statementId}: name the data tool as a quoted string, such as Query("office_items", {}, {rows: []}).`);
    else if (!isDataTool(tool)) problems.push(`${query.statementId}: there is no data tool "${tool}". See the guide for the ones there are.`);
    else problems.push(...checkArguments(query.statementId, tool, query.argsAST));
  }
  for (const mutation of result.mutationStatements) {
    problems.push(`${mutation.statementId}: views can't change anything through Mutation().`);
  }
  return { problems, notes };
}

function literal(node: ASTNode | null): string | null {
  return node?.k === "Str" ? node.v : null;
}

const COMPUTED = Symbol("computed");

/**
 * Checks a query's arguments against its data tool, as far as the program writes them out: every
 * name, and every value that isn't worked out on the page, such as from a filter. A value that is
 * worked out is checked when the dashboard opens.
 */
function checkArguments(statementId: string, tool: DataToolName, node: ASTNode | null): string[] {
  if (node && node.k !== "Obj") return [];
  const input = DATA_TOOLS[tool].input;
  const known = Object.keys(input.shape);
  const takes = known.length ? `It takes ${known.join(", ")}.` : "It takes none.";
  const problems: string[] = [];
  const written: Record<string, unknown> = {};
  const computed = new Set<string>();
  for (const [name, value] of node?.entries ?? []) {
    if (!known.includes(name)) {
      problems.push(`${statementId}: ${tool} takes no argument "${name}". ${takes}`);
      continue;
    }
    const plain = plainValue(value);
    if (plain === COMPUTED) computed.add(name);
    else written[name] = plain;
  }
  const parsed = input.safeParse(written);
  for (const issue of parsed.success ? [] : parsed.error.issues) {
    const name = String(issue.path[0] ?? "");
    if (computed.has(name)) continue;
    problems.push(`${statementId}: ${tool}${name ? ` "${name}"` : ""}: ${issue.message}.`);
  }
  return problems;
}

/** The value a node writes out, or COMPUTED when the page works it out. */
function plainValue(node: ASTNode): unknown {
  switch (node.k) {
    case "Str":
    case "Num":
    case "Bool":
      return node.v;
    case "Null":
      return null;
    case "UnaryOp": {
      const operand = node.op === "-" ? plainValue(node.operand) : COMPUTED;
      return typeof operand === "number" ? -operand : COMPUTED;
    }
    case "Arr": {
      const values = node.els.map(plainValue);
      return values.includes(COMPUTED) ? COMPUTED : values;
    }
    case "Obj": {
      const entries = node.entries.map(([name, value]) => [name, plainValue(value)] as const);
      return entries.some(([, value]) => value === COMPUTED) ? COMPUTED : Object.fromEntries(entries);
    }
    default:
      return COMPUTED;
  }
}
