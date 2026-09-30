/**
 * geminiProvider.js - Google Gemini AI Provider implementation
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

function sanitizeText(text) {
    if (!text) return '';
    // Mask sensitive keys/credentials if accidentally present
    return text.replace(/(AIzaSy[a-zA-Z0-9_-]{33})|(gsk_[a-zA-Z0-9_-]{32,})/g, '[REDACTED_API_KEY]');
}

class GeminiProvider {
    constructor() {
        this.name = 'Gemini';
        this.modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    }

    isAvailable() {
        return Boolean(process.env.GEMINI_API_KEY);
    }

    async generateResponse({ prompt, systemInstruction = '', history = [], maxTokens = 1000 }) {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error('GEMINI_API_KEY is not set');
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: process.env.GEMINI_MODEL || this.modelName,
            systemInstruction: systemInstruction || undefined,
        });

        // Format history for Gemini chat if provided
        const contents = [];
        if (Array.isArray(history) && history.length > 0) {
            // Take up to last 10 turns to avoid unbounded token consumption
            const recentHistory = history.slice(-10);
            for (const h of recentHistory) {
                contents.push({
                    role: h.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: h.content }]
                });
            }
        }

        // Truncate prompt to safe character count (max 4000 chars)
        const truncatedPrompt = prompt.length > 4000 ? prompt.slice(0, 4000) + '...[truncated]' : prompt;
        contents.push({ role: 'user', parts: [{ text: truncatedPrompt }] });

        const result = await model.generateContent({
            contents,
            generationConfig: {
                maxOutputTokens: maxTokens,
                temperature: 0.7,
            }
        });

        const responseText = result?.response?.text();
        if (!responseText) {
            throw new Error('Empty response received from Gemini API');
        }

        return sanitizeText(responseText.trim());
    }
}

module.exports = GeminiProvider;
