import { GoogleGenerativeAI, Content, Part, FunctionCallPart, FunctionResponsePart } from '@google/generative-ai';
import { withStreamRetry } from './geminiRetry';
import { getGeminiModel, trackUsage } from './geminiKeys';
import { toolDeclarations, executeTool } from './agentTools';
import db from '../db/connection';
import fs from 'fs';
import path from 'path';

const SYSTEM_PROMPT = fs.readFileSync(
  path.resolve(__dirname, '../prompts/system.txt'), 'utf-8'
);

interface ChatMessage {
  role: 'user' | 'model';
  parts: Part[];
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
  // Remove the last message (the one we just saved) since we'll send it as the current message
  const pastHistory = history.slice(0, -1);

  await withStreamRetry(async (apiKey) => {
    const genai = new GoogleGenerativeAI(apiKey);
    const model = genai.getGenerativeModel({
      model: getGeminiModel(),
      systemInstruction: SYSTEM_PROMPT,
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
  }).catch(onError);
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
