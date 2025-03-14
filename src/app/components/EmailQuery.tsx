"use client";

import React, { useState, useRef, useEffect } from "react";
import { Send, User, Bot } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Message {
  id: string;
  content: string;
  type: "user" | "assistant";
  timestamp: Date;
  emails?: string[];
}

interface EmailQueryProps {
  token: {
    accessToken: string;
    refreshToken: string;
  };
}

interface QueryResponse {
  answer: string;
  emails?: string[];
}

export default function EmailQuery({ token }: EmailQueryProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "1",
      content:
        "Hi! I can help you search and analyze your emails. Ask me anything about your emails!",
      type: "assistant",
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      content: input,
      type: "user",
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: input,
          token,
        }),
      });

      const data = await response.json();

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        content: data.answer,
        type: "assistant",
        timestamp: new Date(),
        emails: data.emails,
      };

      setMessages((prev) => [...prev, assistantMessage]);
      setResult(data);
    } catch (error) {
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        content: `Sorry, I encountered an error while processing your request. ${error}`,
        type: "assistant",
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMessage]);
      setError(`Sorry, I encountered an error while processing your request. ${error}`);
    } finally {
      setLoading(false);
    }
  };

  const EmailCard = ({ email }: { email: string }) => {
    const lines = email.split('\n');
    const from = lines.find(line => line.startsWith('From:'))?.substring(6) || 'Unknown';
    const subject = lines.find(line => line.startsWith('Subject:'))?.substring(9) || 'No Subject';
    const date = lines.find(line => line.startsWith('Date:'))?.substring(6) || '';
    const content = lines.find(line => line.startsWith('Content:'))?.substring(9) || '';

    return (
      <div className="bg-white rounded-lg shadow p-4 border">
        <div className="font-medium text-gray-800">{subject}</div>
        <div className="text-sm text-gray-600">{from}</div>
        <div className="text-xs text-gray-500 mb-2">{date}</div>
        <div className="text-sm text-gray-700">{content}</div>
      </div>
    );
  };

  return (
    <div className="flex flex-col max-w-4xl mx-auto">
      <div className="bg-white border-b p-4">
        <h1 className="text-xl font-semibold">Email Assistant</h1>
      </div>
      <div className="flex-1 overflow-y-auto bg-gray-50 p-4 space-y-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex flex-col space-y-4 ${
              message.type === "user" ? "items-end" : "items-start"
            }`}
          >
            <div className="flex items-start space-x-2">
              {message.type === "assistant" && (
                <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white">
                  <Bot size={20} />
                </div>
              )}

              <div
                className={`max-w-[80%] rounded-lg p-4 ${
                  message.type === "user"
                    ? "bg-blue-500 text-white"
                    : "bg-white border"
                }`}
              >
                {message.emails && message.emails.length > 0 && (
                  <div className="mb-4">
                    <div className="font-medium mb-2">Relevant Emails:</div>
                    <ScrollArea className="h-[300px] w-full pr-4">
                      <div className="grid gap-4">
                        {message.emails.map((email, index) => (
                          <EmailCard key={index} email={email} />
                        ))}
                      </div>
                    </ScrollArea>
                    <div className="mt-4 pt-4 border-t">
                      <div className="font-medium mb-2">Summary:</div>
                    </div>
                  </div>
                )}
                <p className="whitespace-pre-wrap">{message.content}</p>
              </div>

              {message.type === "user" && (
                <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
                  <User size={20} />
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex items-start space-x-2">
            <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white">
              <Bot size={20} />
            </div>
            <div className="bg-white border rounded-lg p-4">
              <div className="flex space-x-2">
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-100" />
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-200" />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <form
        onSubmit={handleSubmit}
        className="border-t bg-white p-4 max-w-4xl w-full rounded-2xl"
      >
        <div className="flex space-x-4">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about your emails..."
            className="flex-1 border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="bg-blue-500 text-white rounded-lg px-4 py-2 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
          >
            <Send size={20} />
          </button>
        </div>
      </form>
      
      {error && (
        <div className="text-red-500 mb-4">{error}</div>
      )}
    </div>
  );
}
