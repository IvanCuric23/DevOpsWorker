// Cost report for DevOpsWorker runs, read from the pipeline database.
//
//   bun scripts/cost-report.ts --work-item 45            # one ticket, stage by stage
//   bun scripts/cost-report.ts --work-item 45 --md       # the same as a Markdown table
//   bun scripts/cost-report.ts --all                     # one line per ticket
//
// Needs DATABASE_URL (the watcher's .env has it).
import { connectStores } from '../src/db/connect-stores.ts';
import {
  buildCostReport,
  formatCostReportMarkdown,
  formatCostReportText,
  formatCostSummary,
} from '../src/formatters/cost-report.ts';

const args = process.argv.slice(2);
const ids: number[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--work-item') {
    const id = Number(args[++i]);
    if (!Number.isInteger(id) || id <= 0) {
      console.error(`--work-item needs a number, got "${args[i]}"`);
      process.exit(2);
    }
    ids.push(id);
  }
}
const all = args.includes('--all');
const markdown = args.includes('--md');

if (ids.length === 0 && !all) {
  console.error('Usage: bun scripts/cost-report.ts --work-item <id> [--work-item <id> …] [--md] | --all');
  process.exit(2);
}

const { stateStore } = await connectStores();
const wanted = all ? await stateStore.listAll() : ids;
const reports = [];
for (const id of wanted) {
  const state = await stateStore.load(id);
  if (!state) {
    console.error(`No pipeline state for work item #${id}`);
    continue;
  }
  reports.push(buildCostReport(id, state));
}

if (all) {
  console.log(formatCostSummary(reports));
} else {
  console.log(reports.map(r => (markdown ? formatCostReportMarkdown(r) : formatCostReportText(r))).join('\n\n'));
}
process.exit(0);
