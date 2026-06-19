/**
 * ticket-orchestrator.ts — Local ticket-to-PR orchestrator for Compass.
 *
 * Commands:
 *   process   Init next pending ticket → run SDD pipeline → set specs_ready
 *   approve   Mark a specs_ready ticket as approved → ready for implementation
 *   status    List all tickets with their current state
 *
 * Flow:
 *   pending  → run sdd pipeline (explore→propose→spec→design→tasks) via opencode → specs_ready
 *   approved → run sdd apply+verify via opencode → branch, commit, push, PR → done
 */

import matter from 'gray-matter';
import { execSync, ExecSyncOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

type TicketStatus = 'pending' | 'specs_ready' | 'approved' | 'in_progress' | 'review' | 'done' | 'failed';

interface TicketFrontmatter {
  id: string;
  status: TicketStatus;
  approval_required?: boolean;
  approved?: boolean;
  branch?: string;
}

interface Ticket {
  path: string;
  id: string;
  status: TicketStatus;
  frontmatter: TicketFrontmatter;
  body: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PROJECT_ROOT = '/Users/rcarnicer/Desktop/personal-projects/compass';
const OPENCODE = '/Users/rcarnicer/.opencode/bin/opencode';
const TICKETS_DIR = path.join(PROJECT_ROOT, 'tickets');
const OPENSPEC_DIR = path.join(PROJECT_ROOT, 'openspec', 'changes');
const INTEGRATION_BRANCH = 'release/compass_migration';

const EXEC_OPTS: ExecSyncOptions = {
  cwd: PROJECT_ROOT,
  encoding: 'utf-8',
  stdio: ['pipe', 'pipe', 'pipe'],
};

// opencode runs can take minutes
const OPENCODE_TIMEOUT = 300_000;
const OPENCODE_EXEC_OPTS: ExecSyncOptions = { ...EXEC_OPTS, timeout: OPENCODE_TIMEOUT };

// ─── Helpers ───────────────────────────────────────────────────────────────────

function exec(cmd: string, opts?: ExecSyncOptions): string {
  return execSync(cmd, opts ?? EXEC_OPTS).toString().trim();
}

function log(label: string, msg: string): void {
  const ts = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
  console.log(`[${ts}] [${label}] ${msg}`);
}

function logError(label: string, msg: string): void {
  const ts = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
  console.error(`[${ts}] [${label}] ERROR: ${msg}`);
}

// ─── Ticket I/O ────────────────────────────────────────────────────────────────

function readTickets(): Ticket[] {
  if (!fs.existsSync(TICKETS_DIR)) return [];
  return fs.readdirSync(TICKETS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => readTicket(path.join(TICKETS_DIR, f)))
    .filter((t): t is Ticket => t !== null);
}

function readTicket(filePath: string): Ticket | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = matter(raw);
    const fm = parsed.data as TicketFrontmatter;
    return {
      path: filePath,
      id: fm.id || path.basename(filePath, '.md'),
      status: fm.status || 'pending',
      frontmatter: fm,
      body: parsed.content.trim(),
    };
  } catch (err: any) {
    logError('readTicket', `Failed to read ${filePath}: ${err.message}`);
    return null;
  }
}

function writeTicket(ticket: Ticket): void {
  const frontmatter = { ...ticket.frontmatter, status: ticket.status, approved: ticket.frontmatter.approved };
  const content = matter.stringify(ticket.body, frontmatter);
  fs.writeFileSync(ticket.path, content, 'utf-8');
  log('ticket', `Updated ${ticket.id} → status=${ticket.status}`);
}

function updateTicketStatus(
  filePath: string,
  status: TicketStatus,
  extra: Partial<TicketFrontmatter> = {},
): Ticket | null {
  const ticket = readTicket(filePath);
  if (!ticket) return null;
  ticket.status = status;
  Object.assign(ticket.frontmatter, extra, { status });
  writeTicket(ticket);
  return ticket;
}

// ─── SDD Pipeline Execution ──────────────────────────────────────────────────────

function runOpencode(message: string): string {
  const cmd = `${OPENCODE} run "${message.replace(/"/g, '\\"')}"`;
  log('opencode', `Running: ${cmd}`);
  try {
    return exec(cmd, OPENCODE_EXEC_OPTS);
  } catch (err: any) {
    logError('opencode', `opencode failed: ${err.message}`);
    return err.stdout ?? '';
  }
}

/**
 * Execute the full SDD planning pipeline for a ticket.
 * This drives: explore → propose → spec → design → tasks via opencode.
 */
function runSddPlanning(ticket: Ticket): boolean {
  const changeDir = path.join(OPENSPEC_DIR, ticket.id);

  // Ensure change directory exists
  fs.mkdirSync(changeDir, { recursive: true });

  // Write a seed proposal from the ticket body
  const proposalPath = path.join(changeDir, 'proposal.md');
  if (!fs.existsSync(proposalPath)) {
    const proposal = [
      `# ${ticket.id}`,
      '',
      '## Intent',
      '',
      ticket.body,
      '',
      '## Approach',
      '',
      'Implementation approach will be detailed in the technical design.',
      '',
    ].join('\n');
    fs.writeFileSync(proposalPath, proposal, 'utf-8');
    log('planning', `Seeded openspec/changes/${ticket.id}/proposal.md`);
  }

  log('planning', `Launching SDD pipeline for ${ticket.id}...`);

  // Run the full SDD planning pipeline via opencode
  const prompt =
    `For the SDD change '${ticket.id}': you are executing the planning phase. ` +
    `Read the proposal at openspec/changes/${ticket.id}/proposal.md. ` +
    `Run sdd-explore, then sdd-propose, then sdd-spec, then sdd-design, then sdd-tasks. ` +
    `Each phase reads from and writes to the openspec/changes/${ticket.id}/ directory. ` +
    `After all phases complete, print a summary of what was generated.`;

  const output = runOpencode(prompt);

  // Log the opencode output so the user sees what happened
  if (output) {
    console.log(`\n── opencode output ──`);
    console.log(output);
    console.log(`──────────────────────\n`);
  }

  return true;
}

/**
 * Execute the implementation phase for an approved ticket.
 * Runs sdd-apply + sdd-verify via opencode, then drives git/PR flow.
 */
function runSddImplementation(ticket: Ticket): boolean {
  log('impl', `Launching SDD implementation for ${ticket.id}...`);

  const prompt =
    `For the SDD change '${ticket.id}': you are executing the implementation phase. ` +
    `Read the tasks at openspec/changes/${ticket.id}/tasks.md. ` +
    `Run sdd-apply to implement all tasks. Then run sdd-verify to validate. ` +
    `Print a summary of what was implemented and whether all tasks pass.`;

  const output = runOpencode(prompt);

  if (output) {
    console.log(`\n── opencode output ──`);
    console.log(output);
    console.log(`──────────────────────\n`);
  }

  return true;
}

// ─── Git / PR ──────────────────────────────────────────────────────────────────

function isDirty(): boolean {
  return exec('git status --porcelain').trim().length > 0;
}

function executeGitFlow(ticket: Ticket): boolean {
  const branchName = ticket.frontmatter.branch || `feature/${ticket.id}`;
  log('git', `Branch: ${branchName} from ${INTEGRATION_BRANCH}`);

  try {
    // Stash local changes to avoid checkout conflicts
    const hadDirty = isDirty();
    if (hadDirty) {
      exec('git stash push --include-untracked -m "ticket-orchestrator: temporary stash"');
      log('git', 'Stashed local changes');
    }

    // Fetch latest integration branch
    exec(`git fetch origin ${INTEGRATION_BRANCH} 2>/dev/null || true`);

    // Create branch from integration branch (or reuse existing)
    const branchExists = exec(`git branch --list ${branchName}`).trim().length > 0;
    if (branchExists) {
      exec(`git checkout ${branchName} 2>/dev/null`);
      log('git', `Checked out existing branch: ${branchName}`);
    } else {
      exec(`git checkout -b ${branchName} origin/${INTEGRATION_BRANCH}`);
      log('git', `Created branch: ${branchName} from ${INTEGRATION_BRANCH}`);
    }

    // Pop stash so changes are back in working tree
    if (hadDirty) {
      exec('git stash pop 2>/dev/null || true');
      log('git', 'Restored stashed changes');
    }

    // Stage openspec changes for this ticket
    const changeDir = `openspec/changes/${ticket.id}`;
    if (fs.existsSync(path.join(PROJECT_ROOT, changeDir))) {
      exec(`git add ${changeDir}/proposal.md`);
      log('git', 'Staged proposal.md');
    }

    // Check for staged changes
    const diffStat = exec('git diff --cached --stat');
    if (!diffStat.trim()) {
      log('git', 'No changes to commit');
      return true;
    }

    exec(`git commit -m "feat(${ticket.id}): initial SDD proposal

Seeded proposal.md from ticket ${ticket.id} via ticket-orchestrator."`);
    log('git', 'Committed proposal.md');
    return true;
  } catch (err: any) {
    logError('git', err.message);
    return false;
  }
}

function createPullRequest(ticket: Ticket): boolean {
  const branchName = ticket.frontmatter.branch || `feature/${ticket.id}`;

  try {
    exec(`git push -u origin ${branchName} 2>&1`);
    log('pr', `Pushed ${branchName}`);
  } catch (err: any) {
    log('pr', `Push output: ${err.message}`);
    if (err.stderr && err.stderr.includes('rejected')) {
      logError('pr', 'Push rejected — branch may exist remotely with different history');
      return false;
    }
  }

  try {
    const title = `feat: ${ticket.id} — SDD implementation`;
    const body = [
      `## Summary`,
      ``,
      `SDD implementation for ${ticket.id}.`,
      ``,
      `## Artifacts`,
      ``,
      `- Proposal: \`openspec/changes/${ticket.id}/proposal.md\``,
      ``,
      `## Next Steps`,
      ``,
      `1. Review the PR`,
      `2. Merge to \`${INTEGRATION_BRANCH}\``,
    ].join('\n');

    const prUrl = exec(`gh pr create --base ${INTEGRATION_BRANCH} --head ${branchName} --title "${title}" --body "${body}"`);
    log('pr', `PR: ${prUrl}`);
    return true;
  } catch (err: any) {
    logError('pr', `PR creation: ${err.message}`);
    return false;
  }
}

// ─── Commands ──────────────────────────────────────────────────────────────────

function cmdProcess(): void {
  const tickets = readTickets();

  // ── APPROVED → run implementation + git/PR ─────────────────────────────
  const approved = tickets.find(t => t.status === 'approved');
  if (approved) {
    log('process', `Approved: ${approved.id}`);
    updateTicketStatus(approved.path, 'in_progress');

    // Run SDD implementation via opencode
    if (!runSddImplementation(approved)) {
      updateTicketStatus(approved.path, 'failed');
      return;
    }

    // Git flow: branch, commit, push, PR
    if (!executeGitFlow(approved)) {
      updateTicketStatus(approved.path, 'failed');
      return;
    }

    if (!createPullRequest(approved)) {
      updateTicketStatus(approved.path, 'review');
      console.log(`\n⚠️  ${approved.id}: branch created but PR failed. Create manually:`);
      console.log(`   gh pr create --base ${INTEGRATION_BRANCH} --head ${approved.frontmatter.branch || `feature/${approved.id}`}`);
      return;
    }

    updateTicketStatus(approved.path, 'done', { branch: approved.frontmatter.branch || `feature/${approved.id}` });

    console.log(`\n──────────────────────────────────────────────`);
    console.log(`  ✅ ${approved.id}: done`);
    console.log(`  Branch: ${approved.frontmatter.branch || `feature/${approved.id}`}`);
    console.log(`──────────────────────────────────────────────\n`);
    return;
  }

  // ── PENDING → run SDD planning pipeline ───────────────────────────────
  const pending = tickets.find(t => t.status === 'pending');
  if (!pending) {
    log('process', 'No pending or approved tickets found.');
    return;
  }

  log('process', `Pending: ${pending.id}`);

  // 1. Run the full SDD planning pipeline via opencode
  if (!runSddPlanning(pending)) {
    updateTicketStatus(pending.path, 'failed');
    return;
  }

  // 2. Set to specs_ready
  updateTicketStatus(pending.path, 'specs_ready', { approval_required: true, approved: false });

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`  ✅ ${pending.id}: specs_ready`);
  console.log(`  Artifacts: openspec/changes/${pending.id}/`);
  console.log(`  Next: review and approve:`);
  console.log(`    > npm run ticket:approve -- tickets/${pending.id}.md`);
  console.log(`──────────────────────────────────────────────\n`);
}

function cmdApprove(ticketArg: string): void {
  // Resolve path
  let ticketPath = ticketArg;
  if (!path.isAbsolute(ticketPath)) {
    const candidates = [
      path.join(PROJECT_ROOT, ticketPath),
      path.join(TICKETS_DIR, path.basename(ticketArg)),
    ];
    const found = candidates.find(f => fs.existsSync(f));
    if (found) {
      ticketPath = found;
    } else {
      console.error(`Ticket not found: ${ticketArg}`);
      candidates.forEach(c => console.error(`  Tried: ${c}`));
      process.exit(1);
    }
  }

  const ticket = readTicket(ticketPath);
  if (!ticket) {
    console.error(`Failed to read ticket: ${ticketPath}`);
    process.exit(1);
  }

  if (ticket.status !== 'specs_ready') {
    console.error(`Ticket ${ticket.id} must be "specs_ready" to approve (current: ${ticket.status}).`);
    console.error(`Run \`npm run ticket:process\` first.`);
    process.exit(1);
  }

  ticket.status = 'approved';
  ticket.frontmatter.approved = true;
  writeTicket(ticket);

  console.log(`✅ ${ticket.id} approved. Run \`npm run ticket:process\` to implement.`);
}

function cmdStatus(): void {
  const tickets = readTickets();

  if (tickets.length === 0) {
    console.log('No tickets found in tickets/.');
    return;
  }

  const labels: Record<string, string> = {
    pending: '📋 Pending',
    specs_ready: '📝 Specs Ready',
    approved: '✅ Approved',
    in_progress: '🔧 In Progress',
    review: '👀 In Review',
    done: '🎉 Done',
    failed: '❌ Failed',
  };

  console.log('\nTickets:\n');
  for (const t of tickets) {
    const waiting = t.status === 'specs_ready' ? ' ⬅️  WAITING FOR APPROVAL' : '';
    const branch = t.frontmatter.branch ? ` (branch: ${t.frontmatter.branch})` : '';
    const label = labels[t.status] || t.status;
    console.log(`  ${label}  ${t.id}${branch}${waiting}`);
  }
  console.log('');
}

// ─── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const command = process.argv[2];
  const arg = process.argv[3];

  if (!fs.existsSync(TICKETS_DIR)) {
    fs.mkdirSync(TICKETS_DIR, { recursive: true });
    log('init', `Created tickets/`);
  }

  switch (command) {
    case 'process':
      cmdProcess();
      break;
    case 'approve':
      if (!arg) {
        console.error('Usage: npm run ticket:approve -- <ticket-path>');
        console.error('  npm run ticket:approve -- tickets/transfer-risk-policy.md');
        process.exit(1);
      }
      cmdApprove(arg);
      break;
    case 'status':
      cmdStatus();
      break;
    default:
      console.error('Usage:');
      console.error('  npm run ticket:process                Process next ticket');
      console.error('  npm run ticket:approve -- <path>      Approve a specs_ready ticket');
      console.error('  npm run ticket:status                 Show all tickets');
      process.exit(1);
  }
}

main();