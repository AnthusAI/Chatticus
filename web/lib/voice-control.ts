import type { Bot, Channel } from "./api";
import { channelBotIds, directChannelForBot } from "./workspace-state";

/** Where an addressed line goes: the open named channel, or the teammate's direct conversation. */
export type VoiceDestination =
  | { kind: "direct"; botId: string }
  | { kind: "channel"; channelId: string };

/**
 * What one completed line of speech means to the workspace. Only `send`
 * leaves the browser; everything else is handled in the tab.
 */
export type VoiceRoute =
  | { kind: "send"; botId: string; body: string; destination: VoiceDestination }
  | { kind: "select"; botId: string }
  | { kind: "stopListening" }
  | { kind: "notice"; text: string }
  | { kind: "discard" };

export interface VoiceWorkspace {
  bots: Bot[];
  channels: Channel[];
  selectedId: string | null;
  busyChannelIds: string[];
}

export interface VoiceEnvironment {
  crossOriginIsolated: boolean;
  hasMicrophone: boolean;
}

export type VoiceAvailability = { available: true } | { available: false; reason: string };

const STOP_LISTENING_PHRASES = ["stop listening", "stop listening please"];
const SELECT_PREFIXES = ["switch to ", "talk to "];

export function voiceAvailability(environment: VoiceEnvironment): VoiceAvailability {
  if (!environment.crossOriginIsolated) {
    return { available: false, reason: "Voice needs this page to be cross-origin isolated." };
  }
  if (!environment.hasMicrophone) {
    return { available: false, reason: "This browser does not offer a microphone." };
  }
  return { available: true };
}

export function normalizeSpokenText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * American Soundex. Speech-to-text often spells an unfamiliar name the way it
 * sounds ("Grace" heard as "grays"), and Soundex keys both the same way.
 */
export function soundex(word: string): string {
  const codes: Record<string, number> = {
    b: 1, f: 1, p: 1, v: 1,
    c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2,
    d: 3, t: 3,
    l: 4,
    m: 5, n: 5,
    r: 6,
  };
  const letters = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!letters) {
    return "";
  }
  let key = letters[0].toUpperCase();
  let previousCode = codes[letters[0]] ?? 0;
  for (const letter of letters.slice(1)) {
    const code = codes[letter] ?? 0;
    if (code && code !== previousCode) {
      key += String(code);
    }
    if (letter !== "h" && letter !== "w") {
      previousCode = code;
    }
  }
  return `${key}000`.slice(0, 4);
}

/** Number of single-letter edits between two words. */
export function editDistance(left: string, right: string): number {
  let previousRow = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const currentRow = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      currentRow.push(
        Math.min(
          previousRow[rightIndex] + 1,
          currentRow[rightIndex - 1] + 1,
          previousRow[rightIndex - 1] + substitutionCost,
        ),
      );
    }
    previousRow = currentRow;
  }
  return previousRow[right.length];
}

const MAXIMUM_MISHEARD_NAME_EDITS = 2;

/** Words to bias the speech-to-text decoder towards: the teammates' names. */
export function voiceKeyterms(bots: Bot[]): string[] {
  return [...new Set(bots.map((bot) => bot.name.trim()).filter(Boolean))];
}

function findBotBySpokenName(
  bots: Bot[],
  spokenName: string,
  spokenAsAddress: boolean,
): Bot | null {
  const normalizedName = normalizeSpokenText(spokenName);
  const exact = bots.find((bot) => normalizeSpokenText(bot.name) === normalizedName);
  if (exact || !spokenAsAddress || normalizedName.includes(" ")) {
    return exact ?? null;
  }
  const key = soundex(normalizedName);
  const soundsAlike = bots.filter((bot) => {
    const botName = normalizeSpokenText(bot.name);
    return (
      !botName.includes(" ") &&
      soundex(botName) === key &&
      editDistance(botName, normalizedName) <= MAXIMUM_MISHEARD_NAME_EDITS
    );
  });
  return soundsAlike.length === 1 ? soundsAlike[0] : null;
}

function addressedBot(
  text: string,
  bots: Bot[],
): { bot: Bot; remainder: string } | null {
  const trimmed = text.trim();
  for (const bot of [...bots].sort((left, right) => right.name.length - left.name.length)) {
    const name = bot.name.trim();
    if (!name || trimmed.slice(0, name.length).toLowerCase() !== name.toLowerCase()) {
      continue;
    }
    const after = trimmed.slice(name.length);
    if (after === "" || /^\s*[,.:;!?]/.test(after)) {
      return { bot, remainder: after };
    }
  }
  const addressMatch = trimmed.match(/^([\p{L}']+)\s*,([\s\S]*)$/u);
  if (addressMatch) {
    const bot = findBotBySpokenName(bots, addressMatch[1], true);
    if (bot) {
      return { bot, remainder: addressMatch[2] };
    }
  }
  return null;
}

function messageBody(remainder: string): string {
  const body = remainder.replace(/^[\s,.:;!?]+/, "").trim();
  return body ? body[0].toUpperCase() + body.slice(1) : "";
}

function destinationFor(
  botId: string,
  workspace: VoiceWorkspace,
): { destination: VoiceDestination; channelId: string | null } {
  const selectedChannelId = workspace.selectedId?.startsWith("channel:")
    ? workspace.selectedId.slice("channel:".length)
    : null;
  const selectedChannel = workspace.channels.find(
    (channel) => channel.channel_id === selectedChannelId,
  );
  if (selectedChannel && channelBotIds(selectedChannel).includes(botId)) {
    return {
      destination: { kind: "channel", channelId: selectedChannel.channel_id },
      channelId: selectedChannel.channel_id,
    };
  }
  return {
    destination: { kind: "direct", botId },
    channelId: directChannelForBot(workspace.channels, botId)?.channel_id ?? null,
  };
}

/**
 * Decides what a completed line of speech does. A teammate is addressed only
 * when the line is just their name or the transcript punctuates the name as
 * an address ("Ada, open a pull request"), so a name used as an ordinary word
 * ("Grace period ends Friday") stays in the browser. A name that only sounds
 * like a teammate's ("Grays, run the tests") counts when it is also within a
 * couple of letters of it, so rough matches ("Gross, ...") do not.
 */
export function routeVoiceLine(text: string, workspace: VoiceWorkspace): VoiceRoute {
  const normalized = normalizeSpokenText(text);
  if (!normalized) {
    return { kind: "discard" };
  }
  if (STOP_LISTENING_PHRASES.includes(normalized)) {
    return { kind: "stopListening" };
  }
  const selectPrefix = SELECT_PREFIXES.find((prefix) => normalized.startsWith(prefix));
  if (selectPrefix) {
    const bot = findBotBySpokenName(workspace.bots, normalized.slice(selectPrefix.length), true);
    return bot ? { kind: "select", botId: bot.bot_id } : { kind: "discard" };
  }
  const addressed = addressedBot(text, workspace.bots);
  if (!addressed) {
    return { kind: "discard" };
  }
  const body = messageBody(addressed.remainder);
  if (!body) {
    return { kind: "select", botId: addressed.bot.bot_id };
  }
  const { destination, channelId } = destinationFor(addressed.bot.bot_id, workspace);
  if (channelId && workspace.busyChannelIds.includes(channelId)) {
    const name = addressed.bot.name;
    return { kind: "notice", text: `${name} is still working. Say it again when ${name} is done.` };
  }
  return { kind: "send", botId: addressed.bot.bot_id, body, destination };
}
