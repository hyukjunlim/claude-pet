'use strict';

// `npm run demo`: cycles the pet through every status with made-up sessions,
// so you can preview a pet without waiting for Claude to do anything.

const { EventEmitter } = require('node:events');

const now = () => Date.now();
const STEPS = [
  [],
  [{ status: 'running', title: 'Refactor auth middleware', detail: 'Editing session.ts', project: 'auth-service' }],
  [
    { status: 'running', title: 'Refactor auth middleware', detail: 'Run the test suite', project: 'auth-service' },
    { status: 'running', title: 'Write the migration guide', detail: 'Thinking', remote: 'lab-server', project: 'docs' },
  ],
  [
    { status: 'review', title: 'Refactor auth middleware', detail: 'All 42 tests pass; ready to commit', project: 'auth-service' },
    { status: 'running', title: 'Write the migration guide', detail: 'Reading results.csv', remote: 'lab-server', project: 'docs' },
    { status: 'running', title: 'Migrate the billing service to the new events API', detail: 'Editing webhooks.ts', project: 'billing' },
  ],
  [
    { status: 'waiting', title: 'Write the migration guide', detail: 'Which of the 4 sections should I write first?', remote: 'lab-server', project: 'docs' },
    { status: 'review', title: 'Refactor auth middleware', detail: 'All 42 tests pass; ready to commit', project: 'auth-service' },
    { status: 'running', kind: 'codex', title: 'Port the tokenizer to Rust', detail: 'cargo test', remote: 'lab-server', project: 'tokenizer' },
  ],
  [{ status: 'failed', title: 'Dataset cleanup', detail: 'API Error: 529 overloaded', project: 'datasets' }],
  // A busy moment: more bubbles than the default room, so the stack grows.
  [
    { status: 'waiting', title: 'Write the migration guide', project: 'docs' },
    { status: 'failed', title: 'Dataset cleanup', project: 'datasets' },
    { status: 'review', title: 'Refactor auth middleware', project: 'auth-service' },
    { status: 'review', kind: 'codex', title: 'Port the tokenizer to Rust', project: 'tokenizer' },
    { status: 'running', title: 'Migrate the billing service to the new events API', project: 'billing' },
    { status: 'running', title: 'Tune the search ranking', project: 'search' },
    { status: 'running', kind: 'codex', title: 'Add retries to the uploader', project: 'uploader' },
  ],
];

class DemoTracker extends EventEmitter {
  constructor({ stepMs = 6000 } = {}) {
    super();
    this.stepMs = stepMs;
    this.i = 0;
    this.timer = null;
  }

  start() {
    const emit = () => {
      const step = STEPS[this.i % STEPS.length];
      this.i += 1;
      this.emit('change', step.map((s, k) => ({
        id: `demo_${k}_${s.title}`,
        kind: 'demo',
        hostSessionId: null,
        remote: null,
        cwd: null,
        since: now() - (k + 1) * 95_000,
        ...s,
      })));
    };
    emit();
    this.timer = setInterval(emit, this.stepMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  dismiss() {}

  dismissedSnapshot() {
    return {};
  }
}

module.exports = { DemoTracker };
