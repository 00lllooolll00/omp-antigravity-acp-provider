import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Type } from "typebox";

import {
  loadAdapterConfig,
  readOmpApprovalMode,
  resolveAdapterPermissionMode,
  updateAdapterConfig,
} from "../extension/adapter-config.ts";
import { releaseAfter } from "../extension/lock-release.ts";
import {
  ownerRoutingId,
  resolveSessionRoute,
  sessionOwnerId,
  sideParentRoutingId,
} from "../extension/routing.ts";
import { parseAuthorization } from "../extension/vendor/pi-antigravity-acp-provider/src/acp/headless-oauth.ts";
import {
  bridgeExecutionSchema,
  planProjectedToolNames,
} from "../extension/vendor/pi-antigravity-acp-provider/src/mcp/bridge.ts";

test("adapter-config defaults to follow, validates patches before writing and resolves OMP YAML and CLI flags", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-adapter-config-"));
  try {
    const agentDir = path.join(root, "agent");
    const projectDir = path.join(root, "project");
    const configPath = path.join(agentDir, "antigravity-acp-provider", "config.json");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(projectDir, ".omp"), { recursive: true });

    const defaults = loadAdapterConfig(configPath);
    assert.equal(defaults.permissions, "follow");
    assert.equal(defaults.usageMode, "off");

    assert.throws(() => updateAdapterConfig(configPath, { nativeTools: "invalid" as any }), /nativeTools/);
    assert.equal(fs.existsSync(configPath), false);

    // OMP defaults tools.approvalMode to yolo, so follow must not start asking.
    assert.equal(resolveAdapterPermissionMode("follow", agentDir, projectDir), "yolo");
    fs.writeFileSync(path.join(agentDir, "config.yml"), "tools:\n  approvalMode: always-ask\n");
    assert.equal(resolveAdapterPermissionMode("follow", agentDir, projectDir), "default");
    fs.writeFileSync(path.join(agentDir, "config.yml"), "tools:\n  approvalMode: write\n");
    assert.equal(readOmpApprovalMode(agentDir, projectDir, ["node", "omp"]), "write");
    assert.equal(resolveAdapterPermissionMode("follow", agentDir, projectDir), "auto_edit");

    fs.writeFileSync(path.join(projectDir, ".omp", "config.yaml"), "tools: { approvalMode: yolo }\n");
    assert.equal(resolveAdapterPermissionMode("follow", agentDir, projectDir), "yolo");

    assert.equal(readOmpApprovalMode(agentDir, projectDir, ["node", "omp", "--approval-mode=always-ask"]), "always-ask");
    assert.equal(readOmpApprovalMode(agentDir, projectDir, ["node", "omp", "--auto-approve"]), "yolo");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("routing separates main routes from :side: shadow routes", () => {
  assert.equal(sideParentRoutingId("main-1:side:btw:0"), "main-1");
  assert.equal(sideParentRoutingId("main-1:spec:plan"), undefined);
  assert.equal(sideParentRoutingId("main-1:side:a:side:b"), undefined);
  assert.equal(ownerRoutingId("main-1:side:btw:0"), "main-1");
  assert.deepEqual(resolveSessionRoute("main-1:side:btw:0", "main-parent"), {
    kind: "shadow",
    routingId: "main-1:side:btw:0",
    parentRoutingId: "main-parent",
  });
  assert.equal(sessionOwnerId("main-1:side:btw:0", "main-parent"), "main-parent");
  assert.equal(sessionOwnerId("main-1"), "main-1");
});

test("releaseAfter always releases the lock and preserves primary vs release/compromised errors", async () => {
  let released = 0;
  await releaseAfter(async () => { released++; }, false);
  assert.equal(released, 1);

  await assert.rejects(
    () => releaseAfter(async () => { throw new Error("unlock failed"); }, false),
    /unlock failed/,
  );

  await assert.rejects(
    () => releaseAfter(async () => {}, false, new Error("lock compromised")),
    /lock compromised/,
  );

  await releaseAfter(async () => { throw new Error("unlock failed"); }, true, new Error("ignored"));
});

test("parseAuthorization accepts AccountChooser, /o/oauth2/auth and /signin/oauth URLs", () => {
  const inner = "https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A4321%2Fcb&state=s1";
  const chooser = `https://accounts.google.com/AccountChooser?continue=${encodeURIComponent(inner)}`;
  const parsedChooser = parseAuthorization(chooser);
  assert.equal(parsedChooser.state, "s1");
  assert.equal(parsedChooser.redirectUrl.port, "4321");

  const signin = parseAuthorization("https://accounts.google.com/signin/oauth?redirect_uri=http%3A%2F%2Flocalhost%3A9999%2F&state=s2");
  assert.equal(signin.state, "s2");

  const evilContinue = "https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fevil.example%2Fo%2Foauth2%2Fauth";
  assert.throws(() => parseAuthorization(evilContinue), /unexpected OAuth authorization URL/);
});

test("MCP bridge relaxes injected intent for context_notes/new_context and reserves a slot for task", () => {
  const notesTool = {
    name: "context_notes",
    description: "notes",
    parameters: Type.Object({ i: Type.String(), text: Type.String() }, { additionalProperties: false }),
  };
  const relaxedNotes = bridgeExecutionSchema(notesTool) as unknown as { required: string[] };
  assert.deepEqual(relaxedNotes.required, ["text"]);

  const genericTool = {
    name: "read",
    description: "read",
    parameters: Type.Object({ i: Type.String(), path: Type.String() }, { additionalProperties: false }),
  };
  const untouched = bridgeExecutionSchema(genericTool) as unknown as { required: string[] };
  assert.deepEqual(untouched.required, ["i", "path"]);

  const tools = [
    ...Array.from({ length: 65 }, (_, index) => ({
      name: `tool_${index}`,
      description: `tool ${index}`,
      parameters: Type.Object({ path: Type.String() }),
    })),
    {
      name: "task",
      description: "delegate",
      parameters: Type.Object({ prompt: Type.String() }),
    },
  ];
  const projected = planProjectedToolNames(tools);
  assert.equal(projected.length, 64);
  assert.equal(projected[62], "tool_62");
  assert.equal(projected[63], "task");
});
