import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import autoresearchExtension from "../extensions/pi-autoresearch/index.ts";

async function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withAgentDir(agentDir, fn) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

function writeAutoresearchLog(workDir) {
  fs.writeFileSync(
    path.join(workDir, "autoresearch.jsonl"),
    [
      '{"type":"config","name":"Speed","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}',
      '{"run":1,"commit":"abc1234","metric":10,"metrics":{},"status":"keep","description":"baseline","timestamp":1,"confidence":null}',
    ].join("\n") + "\n",
  );
}

function createHarness(agentDir) {
  const handlers = new Map();
  const commands = new Map();
  const shortcuts = [];
  const userMessages = [];
  const customEntries = [];

  withAgentDir(agentDir, () => {
    autoresearchExtension({
      on(name, handler) {
        handlers.set(name, handler);
      },
      registerTool() {},
      registerCommand(name, options) {
        commands.set(name, options);
      },
      registerShortcut(shortcut, options) {
        shortcuts.push({ shortcut, options });
      },
      appendEntry(customType, data) {
        customEntries.push({ customType, data });
      },
      sendUserMessage(content, options) {
        userMessages.push({ content, options });
      },
    });
  });

  return { handlers, commands, shortcuts, userMessages, customEntries };
}

function createCtx(cwd) {
  const widgets = [];
  const notifications = [];
  let aborted = false;

  const ctx = {
    cwd,
    hasUI: true,
    sessionManager: {
      getSessionId() {
        return `session-${cwd}`;
      },
      getBranch() {
        return [];
      },
    },
    ui: {
      setWidget(key, value) {
        widgets.push({ key, value });
      },
      notify(message, type) {
        notifications.push({ message, type });
      },
      custom() {
        throw new Error("custom UI should not open in this test");
      },
    },
    isIdle() {
      return true;
    },
    hasPendingMessages() {
      return false;
    },
    abort() {
      aborted = true;
    },
  };

  return { ctx, widgets, notifications, get aborted() { return aborted; } };
}

async function fireSessionStart(harness, ctx) {
  const handler = harness.handlers.get("session_start");
  assert.equal(typeof handler, "function");
  await handler({}, ctx);
}

test("restored autoresearch.jsonl history does not render the widget while mode is off", async () => {
  await withTempDir("pi-autoresearch-mode-ui-work-", async (workDir) => {
    await withTempDir("pi-autoresearch-mode-ui-agent-", async (agentDir) => {
      writeAutoresearchLog(workDir);
      const harness = createHarness(agentDir);
      const state = createCtx(workDir);

      await fireSessionStart(harness, state.ctx);

      assert.deepEqual(state.widgets.at(-1), {
        key: "autoresearch",
        value: undefined,
      });
      assert.equal(state.notifications.length, 0);
    });
  });
});

test("dashboard toggle shortcut does not reveal restored history when autoresearch mode is off", async () => {
  await withTempDir("pi-autoresearch-mode-ui-work-", async (workDir) => {
    await withTempDir("pi-autoresearch-mode-ui-agent-", async (agentDir) => {
      writeAutoresearchLog(workDir);
      const harness = createHarness(agentDir);
      const state = createCtx(workDir);

      await fireSessionStart(harness, state.ctx);
      const toggle = harness.shortcuts.find((entry) => entry.options.description === "Toggle autoresearch dashboard");
      assert.ok(toggle);

      await toggle.options.handler(state.ctx);

      assert.match(state.notifications.at(-1).message, /mode is off/i);
      assert.equal(state.widgets.some((entry) => entry.value !== undefined), false);
    });
  });
});

test("explicit /autoresearch goal shows the widget again", async () => {
  await withTempDir("pi-autoresearch-mode-ui-work-", async (workDir) => {
    await withTempDir("pi-autoresearch-mode-ui-agent-", async (agentDir) => {
      const harness = createHarness(agentDir);
      const state = createCtx(workDir);
      const command = harness.commands.get("autoresearch");
      assert.ok(command);

      await fireSessionStart(harness, state.ctx);
      await command.handler("optimize unit test runtime", state.ctx);

      assert.equal(state.widgets.at(-1).key, "autoresearch");
      assert.equal(typeof state.widgets.at(-1).value, "function");
      assert.match(state.notifications.at(-1).message, /interview mode on/i);
      assert.equal(harness.userMessages.length, 1);
    });
  });
});
