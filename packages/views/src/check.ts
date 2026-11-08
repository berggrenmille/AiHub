import { createParser, type ASTNode, type ParseResult } from "@openuidev/lang-core";
import { isDataTool } from "./data.ts";
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
  }
  for (const mutation of result.mutationStatements) {
    problems.push(`${mutation.statementId}: views can't change anything through Mutation().`);
  }
  return { problems, notes };
}

function literal(node: ASTNode | null): string | null {
  return node?.k === "Str" ? node.v : null;
}
