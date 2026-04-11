import { GoogleGenerativeAI, Content, Part, FunctionResponsePart } from '@google/generative-ai';
import { withStreamRetry } from './geminiRetry';
import { getGeminiModel, trackUsage } from './geminiKeys';
import { toolDeclarations, executeTool } from './agentTools';
import db from '../db/connection';
import fs from 'fs';
import path from 'path';
import { selectSkillsForChat } from './skillLoader';

const SYSTEM_PROMPT = fs.readFileSync(
  path.resolve(__dirname, '../prompts/system.txt'), 'utf-8'
);

function composeSystemPrompt(userMessage: string): string {
  const skills = selectSkillsForChat(userMessage);
  if (skills.length === 0) {
    return SYSTEM_PROMPT;
  }

  const skillBlock = skills.map(skill => `## Active Skill: ${skill.name}\n${skill.content}`).join('\n\n');
  return `${SYSTEM_PROMPT}\n\n${skillBlock}`;
}

interface ChatMessage {
  role: 'user' | 'model';
  parts: Part[];
}

interface DirectGenerateIntent {
  item: string;
  platform?: string;
}

const SUPPORTED_PLATFORM_ALIASES = ['官網', 'website', 'facebook', 'fb', '8891', 'json', '全平台', '全部文案', '全部平台', 'all platform', 'all copy'];

function extractItemCode(text: string): string | null {
  const itemMatch = String(text || '').match(/\b([A-Za-z]{0,2}\d{1,4})\b/);
  return itemMatch ? itemMatch[1] : null;
}

function detectPlatform(text: string): string | undefined {
  const raw = String(text || '');
  const lower = raw.toLowerCase();

  if (raw.includes('全平台') || raw.includes('全部文案') || raw.includes('全部平台') || lower.includes('all platform') || lower.includes('all copy')) {
    return undefined;
  }
  if (raw.includes('官網') || lower.includes('website') || lower.includes('web copy')) return '官網';
  if (raw.includes('Facebook') || raw.includes('facebook') || raw.includes('FB') || lower.includes('fb')) return 'Facebook';
  if (raw.includes('8891') || lower.includes('json')) return '8891';
  return undefined;
}

function countMentionedPlatforms(text: string): number {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  let count = 0;
  if (raw.includes('官網') || lower.includes('website') || lower.includes('web copy')) count += 1;
  if (raw.includes('Facebook') || raw.includes('facebook') || raw.includes('FB') || lower.includes('fb')) count += 1;
  if (raw.includes('8891') || lower.includes('json')) count += 1;
  return count;
}

function mentionsUnsupportedPlatform(text: string): boolean {
  const raw = String(text || '').trim();
  const lower = raw.toLowerCase();
  const mentionsPlatformWord = /文案|copy|平台|platform|json|官網|facebook|fb|8891|instagram|ig/.test(raw + lower);
  if (!mentionsPlatformWord) return false;
  return ['instagram', 'ig', 'threads', 'line', 'tiktok'].some(token => lower.includes(token));
}

function hasOneOffGenerationConstraints(text: string): boolean {
  return ['語氣', '不要', '改成', '風格', '強調', '避免', '成熟', '活潑', '別提', '加上', 'tone', 'style', 'avoid', 'mention'].some(token => String(text || '').includes(token) || String(text || '').toLowerCase().includes(token));
}

function isGenerateRequest(text: string): boolean {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  return ['生成', '產生', '出文案', '產出', 'generate', 'create'].some(token => raw.includes(token) || lower.includes(token));
}

function isAffirmativeFollowup(text: string): boolean {
  const normalized = String(text || '').trim().toLowerCase();
  return ['好', '可以', '確認', '是', 'yes', 'ok', 'okay', 'generate it now', '直接生成', '直接產生'].includes(normalized);
}

function parseDirectGenerateIntent(userMessage: string): DirectGenerateIntent | null {
  const text = String(userMessage || '').trim();
  if (!isGenerateRequest(text)) return null;
  if (/[?？嗎]$/.test(text) || text.includes('能不能') || text.includes('可以直接生成')) return null;
  if (mentionsUnsupportedPlatform(text)) return null;
  if (hasOneOffGenerationConstraints(text)) return null;

  const item = extractItemCode(text);
  if (!item) return null;

  const lower = text.toLowerCase();
  const referencesSupportedPlatform = SUPPORTED_PLATFORM_ALIASES.some(token => text.includes(token) || lower.includes(token));
  if (!referencesSupportedPlatform) return null;
  if (countMentionedPlatforms(text) > 1 && !(text.includes('全平台') || text.includes('全部文案') || text.includes('全部平台') || lower.includes('all platform') || lower.includes('all copy'))) {
    return null;
  }

  return {
    item,
    platform: detectPlatform(text),
  };
}

function parseOwnerCheckIntent(userMessage: string): { item: string } | null {
  const text = String(userMessage || '').trim();
  const lower = text.toLowerCase();
  const looksLikeOwnerCheck = [
    'owner 怎麼處理',
    'owner 狀態',
    '檢查 owner',
    'resolve owner',
    '負責人怎麼處理',
    '車主怎麼處理',
  ].some(token => text.includes(token) || lower.includes(token));
  if (!looksLikeOwnerCheck) return null;
  const item = extractItemCode(text);
  return item ? { item } : null;
}

function parseReadinessIntent(userMessage: string): { item: string } | null {
  const text = String(userMessage || '').trim();
  const lower = text.toLowerCase();
  if (isGenerateRequest(text) && detectPlatform(text)) return null;
  const looksLikeReadiness = ['適合生成', '能不能生成', '可以直接生成', '阻擋因素', '生成前', 'readiness check', 'ready to generate'].some(token => text.includes(token) || lower.includes(token));
  if (!looksLikeReadiness) return null;
  const item = extractItemCode(text);
  return item ? { item } : null;
}

function extractTextParts(message: ChatMessage | undefined): string {
  if (!message) return '';
  return message.parts.map(part => ('text' in part && typeof part.text === 'string' ? part.text : '')).join(' ').trim();
}

async function completeRoutedResponse(
  sessionId: string,
  run: () => Promise<string>,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: Error) => void,
): Promise<boolean> {
  try {
    const toolResult = await run();
    saveMessage(sessionId, 'assistant', toolResult);
    onChunk(toolResult);
    onDone();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    saveMessage(sessionId, 'assistant', `Error: ${message}`);
    onError(err instanceof Error ? err : new Error(message));
    return true;
  }
}

function parseFollowupGenerateIntent(history: ChatMessage[], userMessage: string): DirectGenerateIntent | null {
  if (!isAffirmativeFollowup(userMessage)) return null;

  const previousMessages = history.slice(0, -1);
  const lastUser = [...previousMessages].reverse().find(msg => msg.role === 'user');
  const lastAssistant = [...previousMessages].reverse().find(msg => msg.role === 'model');
  const lastUserText = extractTextParts(lastUser);
  const lastAssistantText = extractTextParts(lastAssistant);
  const assistantAskedToGenerate = [
    '是否直接生成',
    '是否要直接生成',
    '是否要繼續生成',
    '是否要生成',
    '您確定要現在生成',
    'please confirm generation',
  ].some(token => lastAssistantText.includes(token) || lastAssistantText.toLowerCase().includes(token));

  if (!lastUserText || !/生成|產生|generate|create/i.test(lastUserText)) return null;
  if (!assistantAskedToGenerate) return null;

  const item = extractItemCode(lastUserText);
  if (!item) return null;

  return {
    item,
    platform: detectPlatform(lastUserText),
  };
}

/** Load chat history for a session */
function loadHistory(sessionId: string): ChatMessage[] {
  const rows = db.prepare(
    'SELECT role, content, tool_calls FROM chat_history WHERE session_id = ? ORDER BY created_at ASC'
  ).all(sessionId) as any[];

  return rows.map(row => ({
    role: row.role === 'assistant' ? 'model' : row.role,
    parts: [{ text: row.content }],
  }));
}

/** Save a message to chat history */
function saveMessage(sessionId: string, role: string, content: string, toolCalls?: string): void {
  db.prepare(
    'INSERT INTO chat_history (session_id, role, content, tool_calls) VALUES (?, ?, ?, ?)'
  ).run(sessionId, role, content, toolCalls || null);
}

/**
 * Process a chat message with the AI agent.
 * Supports SSE streaming and function calling.
 */
export async function processChat(
  sessionId: string,
  userMessage: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: Error) => void
): Promise<void> {
  saveMessage(sessionId, 'user', userMessage);

  const history = loadHistory(sessionId);

  const ownerCheck = parseOwnerCheckIntent(userMessage);
  if (ownerCheck) {
    await completeRoutedResponse(sessionId, () => executeTool('resolve_owner', { item: ownerCheck.item, action: 'check' }), onChunk, onDone, onError);
    return;
  }

  const readinessCheck = parseReadinessIntent(userMessage);
  if (readinessCheck) {
    await completeRoutedResponse(sessionId, () => executeTool('get_generation_readiness', { item: readinessCheck.item }), onChunk, onDone, onError);
    return;
  }

  const directGenerate = parseDirectGenerateIntent(userMessage);
  if (directGenerate) {
    await completeRoutedResponse(sessionId, () => executeTool('generate_copy', directGenerate), onChunk, onDone, onError);
    return;
  }

  const followupGenerate = parseFollowupGenerateIntent(history, userMessage);
  if (followupGenerate) {
    await completeRoutedResponse(sessionId, () => executeTool('generate_copy', followupGenerate), onChunk, onDone, onError);
    return;
  }

  // Remove the last message (the one we just saved) since we'll send it as the current message
  const pastHistory = history.slice(0, -1);

  await withStreamRetry(async (apiKey) => {
    const genai = new GoogleGenerativeAI(apiKey);
    const model = genai.getGenerativeModel({
      model: getGeminiModel(),
      systemInstruction: composeSystemPrompt(userMessage),
      tools: [{ functionDeclarations: toolDeclarations }],
    });

    const chat = model.startChat({
      history: pastHistory as Content[],
    });

    let fullResponse = '';
    let result = await chat.sendMessageStream(userMessage);

    for await (const chunk of result.stream) {
      // Check for function calls
      const functionCalls = chunk.functionCalls();
      if (functionCalls && functionCalls.length > 0) {
        // Execute function calls
        const functionResponses: FunctionResponsePart[] = [];
        for (const fc of functionCalls) {
          const toolResult = await executeTool(fc.name, fc.args);
          functionResponses.push({
            functionResponse: {
              name: fc.name,
              response: { result: toolResult },
            },
          });
        }

        // Send function results back and stream the response
        result = await chat.sendMessageStream(functionResponses);
        for await (const chunk2 of result.stream) {
          const text = chunk2.text();
          if (text) {
            fullResponse += text;
            onChunk(text);
          }
        }
      } else {
        const text = chunk.text();
        if (text) {
          fullResponse += text;
          onChunk(text);
        }
      }
    }

    // Track usage
    const response = await result.response;
    if (response.usageMetadata) {
      trackUsage(apiKey, getGeminiModel(), 'chat', response.usageMetadata);
    }

    saveMessage(sessionId, 'assistant', fullResponse);
    onDone();
  }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    saveMessage(sessionId, 'assistant', `Error: ${message}`);
    onError(err instanceof Error ? err : new Error(message));
  });
}

/** Get chat history for a session */
export function getChatHistory(sessionId: string): Array<{ role: string; content: string; createdAt: string }> {
  return db.prepare(
    'SELECT role, content, created_at as createdAt FROM chat_history WHERE session_id = ? ORDER BY created_at ASC'
  ).all(sessionId) as any[];
}

/** Clear chat history for a session */
export function clearChatHistory(sessionId: string): void {
  db.prepare('DELETE FROM chat_history WHERE session_id = ?').run(sessionId);
}
