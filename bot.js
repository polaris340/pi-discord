import { Client, GatewayIntentBits, Partials } from "discord.js";
import { spawn } from "child_process";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const WORKSPACE = "/workspace";

const EDIT_INTERVAL = 1500;
const MAX_MSG_LENGTH = 1900;

// ── Discord client ──────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel], // required to receive DM events
});

client.once("ready", () => {
  console.log(`Bot ready: ${client.user.tag}`);
});

// ── pi RPC session management ───────────────────────────────────────
const sessions = new Map();
let globalReqId = 0;

function getOrCreateSession(channelId) {
  if (sessions.has(channelId)) return sessions.get(channelId);

  console.log(`[${channelId}] starting pi session`);

  const proc = spawn("pi", ["--mode", "rpc"], { cwd: WORKSPACE });

  const session = {
    proc,
    channelId,
    outputBuffer: "",
    onChunk: null,
    onDone: null,
    onResponse: null, // callback for command responses (model change, etc.)
  };

  // Line-buffered stdout parsing for reliable JSON handling
  let lineBuf = "";
  proc.stdout.on("data", (data) => {
    lineBuf += data.toString();
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop(); // preserve incomplete trailing line
    for (const line of lines) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        handlePiEvent(session, event);
      } catch { }
    }
  });

  proc.stderr.on("data", (data) => {
    console.error(`[pi stderr] ${data}`);
  });

  proc.on("error", (err) => {
    console.error(`[${channelId}] pi spawn failed:`, err.message);
    session.onDone?.("❌ Failed to start pi: " + err.message);
    sessions.delete(channelId);
  });

  proc.on("exit", (code) => {
    console.log(`[${channelId}] pi exited (code ${code})`);
    if (session.onDone) {
      const msg = session.outputBuffer || `❌ pi exited (code ${code})`;
      session.onDone(msg);
    }
    sessions.delete(channelId);
  });

  sessions.set(channelId, session);
  return session;
}

// ── pi RPC event handling ───────────────────────────────────────────
// Protocol: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md
function handlePiEvent(session, event) {
  switch (event.type) {
    // Command acknowledgement / response
    case "response":
      if (session.onResponse) {
        session.onResponse(event);
        session.onResponse = null;
      } else if (!event.success) {
        session.outputBuffer += `\n❌ ${event.error}`;
        session.onChunk?.(session.outputBuffer);
      }
      break;

    // Text streaming via assistantMessageEvent.text_delta
    case "message_update": {
      const ame = event.assistantMessageEvent;
      if (ame?.type === "text_delta" && ame.delta) {
        session.outputBuffer += ame.delta;
        session.onChunk?.(session.outputBuffer);
      }
      break;
    }

    // Tool execution started
    case "tool_execution_start":
      session.outputBuffer += `\n\`[${event.toolName}]\` `;
      session.onChunk?.(session.outputBuffer);
      break;

    // Tool execution finished
    case "tool_execution_end":
      if (event.result?.content) {
        for (const c of event.result.content) {
          if (c.type === "text" && c.text) {
            const preview = c.text.slice(0, 200);
            session.outputBuffer += `\n\`\`\`\n${preview}${c.text.length > 200 ? "\n..." : ""}\n\`\`\``;
          }
        }
        session.onChunk?.(session.outputBuffer);
      }
      break;

    // Interactive UI request from pi (confirm, select, input, etc.)
    case "extension_ui_request":
      handleUiRequest(session, event);
      break;

    // Agent response complete
    case "agent_end":
      session.onDone?.(session.outputBuffer);
      session.outputBuffer = "";
      session.onChunk = null;
      session.onDone = null;
      break;
  }
}

// Auto-respond to pi UI requests (interactive UI not available in Discord)
function handleUiRequest(session, event) {
  const response = { type: "extension_ui_response", id: event.id };

  switch (event.method) {
    case "confirm":
      // Auto-approve (runs inside isolated container)
      response.confirmed = true;
      break;
    case "select":
      response.value = event.options?.[0]?.value ?? "";
      break;
    case "input":
    case "editor":
      // Cannot get interactive input via Discord; cancel
      response.cancelled = true;
      session.outputBuffer += "\n⚠️ Skipped interactive input (not supported in Discord).";
      session.onChunk?.(session.outputBuffer);
      break;
    default:
      // notify, setStatus, etc. need no response
      return;
  }

  session.proc.stdin.write(JSON.stringify(response) + "\n");
}

// ── pi RPC commands ─────────────────────────────────────────────────
function sendRpc(session, cmd) {
  const id = `req-${++globalReqId}`;
  session.proc.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
}

// !command → RPC command mapping (same names as pi TUI's /commands)
const COMMANDS = {
  // Session
  new:     { run: (s) => sendRpc(s, { type: "new_session" }),         reply: "🔄 Starting new session." },
  reset:   { run: (s) => sendRpc(s, { type: "new_session" }),         reply: "🔄 Session reset." },
  compact: { run: (s) => sendRpc(s, { type: "compact" }),             reply: "📦 Compacting context." },

  // Execution control
  abort: {
    run: (s) => {
      sendRpc(s, { type: "abort" });
      s.outputBuffer = "";
      s.onChunk = null;
      s.onDone = null;
    },
    reply: "🛑 Aborted.",
  },

  // Process control (bot-only, not a pi RPC command)
  kill: {
    run: (s, _args, _msg, channelId) => {
      s.onDone = null;
      s.onChunk = null;
      s.proc.kill();
      sessions.delete(channelId);
    },
    reply: "💀 pi process killed.",
  },

  // Model
  model: {
    async run(s, args, message) {
      if (!args) {
        // !model → cycle to next model
        s.onResponse = async (res) => {
          if (res.success) await message.reply(`🔄 ${res.data?.provider ?? ""}/${res.data?.modelId ?? ""}`);
          else await message.reply(`❌ ${res.error}`);
        };
        sendRpc(s, { type: "cycle_model" });
      } else {
        const parts = args.split(/\s+/);
        if (parts.length < 2) {
          await message.reply("Usage: `!model <provider> <modelId>` or `!model` (cycle)");
          return;
        }
        s.onResponse = async (res) => {
          if (res.success) await message.reply(`✅ ${parts[0]}/${parts[1]}`);
          else await message.reply(`❌ ${res.error}`);
        };
        sendRpc(s, { type: "set_model", provider: parts[0], modelId: parts[1] });
      }
    },
  },

  // Thinking level
  thinking: {
    async run(s, args, message) {
      if (!args) {
        s.onResponse = async (res) => {
          if (res.success) await message.reply(`🧠 thinking: ${res.data?.level ?? "changed"}`);
          else await message.reply(`❌ ${res.error}`);
        };
        sendRpc(s, { type: "cycle_thinking_level" });
      } else {
        const level = args.trim();
        s.onResponse = async (res) => {
          if (res.success) await message.reply(`🧠 thinking: ${level}`);
          else await message.reply(`❌ ${res.error}`);
        };
        sendRpc(s, { type: "set_thinking_level", level });
      }
    },
  },

};

async function handleHelp(message) {
  const lines = [
    "**Built-in commands:**",
    "`!model` — cycle to next model",
    "`!model <provider> <modelId>` — set model",
    "`!thinking` — cycle thinking level",
    "`!thinking <off|minimal|low|medium|high|xhigh>` — set thinking level",
    "`!compact` — compact context",
    "`!new` `!reset` — new session",
    "`!abort` — abort current task",
    "`!kill` — kill pi process",
  ];

  // Fetch dynamic command list from pi if session exists
  const session = sessions.get(message.channelId);
  if (session) {
    const cmds = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 5000);
      session.onResponse = (res) => {
        clearTimeout(timeout);
        resolve(res.success ? res.data?.commands : null);
      };
      sendRpc(session, { type: "get_commands" });
    });

    if (cmds?.length) {
      lines.push("", "**pi commands (extension/prompt/skill):**");
      for (const c of cmds) {
        const desc = c.description ? ` — ${c.description}` : "";
        lines.push(`\`!${c.name}\`${desc}`);
      }
    }
  }

  lines.push("", "Any other `!xxx` is forwarded to pi as `/xxx`.");
  await message.reply(lines.join("\n"));
}

// ── Discord message handler ─────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (ALLOWED_USER_ID && message.author.id !== ALLOWED_USER_ID) return;

  let text = message.content.trim();
  if (!text) return;

  // ! command handling (mirrors pi TUI's /commands, using ! to avoid Discord conflicts)
  if (text.startsWith("!")) {
    const spaceIdx = text.indexOf(" ");
    const cmdName = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
    const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

    // !help works without an active session
    if (cmdName === "help") {
      await handleHelp(message);
      return;
    }

    const cmd = COMMANDS[cmdName];
    if (cmd) {
      // Built-in command → send as dedicated RPC type
      const session = sessions.get(message.channelId);
      if (!session) {
        await message.reply("No active session. Send a message first.");
        return;
      }
      await cmd.run(session, args, message, message.channelId);
      if (cmd.reply) await message.reply(cmd.reply);
      return;
    }

    // Unknown command → forward to pi as /command
    // (automatically supports extension, prompt template, and skill commands)
    text = "/" + cmdName + (args ? " " + args : "");
  }

  const session = getOrCreateSession(message.channelId);

  // Reject if already processing a request
  if (session.onChunk) {
    await message.reply("⏳ Busy. Use `!abort` to cancel or `!kill` to force-quit.");
    return;
  }

  const reply = await message.reply("⏳ Thinking...");

  let lastEditContent = "";
  let editTimer = null;
  let latestContent = "";
  let editChain = Promise.resolve();
  const extraMessages = [reply];

  // Throttled edit: update Discord message with latest buffer every EDIT_INTERVAL ms
  const scheduleEdit = (content) => {
    latestContent = content;
    if (editTimer) return;
    editTimer = setTimeout(() => {
      editTimer = null;
      if (latestContent === lastEditContent) return;
      lastEditContent = latestContent;
      const c = latestContent;
      editChain = editChain.then(() => updateMessages(extraMessages, c, false));
    }, EDIT_INTERVAL);
  };

  session.onChunk = (buf) => scheduleEdit(buf);

  session.onDone = (buf) => {
    if (editTimer) {
      clearTimeout(editTimer);
      editTimer = null;
    }
    const content = buf || "*(empty response)*";
    editChain = editChain.then(() => updateMessages(extraMessages, content, true));
  };

  sendRpc(session, { type: "prompt", message: text });
});

// ── Message splitting & edit helpers ────────────────────────────────
async function updateMessages(msgList, content, isDone) {
  const chunks = splitIntoChunks(content);

  for (let i = 0; i < chunks.length; i++) {
    const suffix = isDone && i === chunks.length - 1 ? "\n\n✅" : isDone ? "" : "\n\n⏳";

    if (i < msgList.length) {
      try { await msgList[i].edit(chunks[i] + suffix); }
      catch (e) { console.error("edit failed:", e.message); }
    } else {
      try {
        const newMsg = await msgList[msgList.length - 1].reply(chunks[i] + suffix);
        msgList.push(newMsg);
      } catch (e) { console.error("new message failed:", e.message); }
    }
  }
}

// Split text at newline boundaries to avoid breaking markdown
function splitIntoChunks(text) {
  const chunks = [];
  while (text.length > MAX_MSG_LENGTH) {
    let cut = text.lastIndexOf("\n", MAX_MSG_LENGTH);
    if (cut <= 0) cut = MAX_MSG_LENGTH;
    chunks.push(text.slice(0, cut));
    text = text.slice(cut);
  }
  if (text) chunks.push(text);
  return chunks.length ? chunks : [""];
}

// ── Start ───────────────────────────────────────────────────────────
client.login(DISCORD_TOKEN);
