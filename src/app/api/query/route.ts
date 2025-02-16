// pages/api/query.ts
import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { HfInference } from "@huggingface/inference";

const oauth2Client = new OAuth2Client({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: process.env.REDIRECT_URI,
});

const hf = new HfInference(process.env.HF_API_KEY);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateSearchQuery(query: string): Promise<string> {
  await sleep(500);

  const prompt = `[INST] <<SYS>>
You are an email search expert. Convert the user's natural language query into simplified search terms following these rules:

1. Keep only essential keywords
2. Remove articles (a, an, the) and common verbs
3. Remove time-related phrases
4. Focus on subject matter and key terms
5. Separate keywords with spaces

Examples:
- "what was my latest twitter bill" -> "from:twitter invoice payment bill after:2024/01/01"
- "when did I have a calendly call with marketing" -> "from:calendly marketing meeting"
- "find AWS charges from last quarter" -> "from:aws invoice payment after:2024/01/01"
- "emails about the frontend deployment" -> "subject:(frontend deployment) deploy"
<</SYS>>

Convert this query: "${query}" [/INST]

Search terms:`;

  try {
    const response = await hf.textGeneration({
      model: "mistralai/Mistral-7B-Instruct-v0.2",
      inputs: prompt,
      parameters: {
        max_new_tokens: 20,
        temperature: 0.2,
        stop: ["\n", "</s>", "[INST]"],
      },
    });

    const generated = response.generated_text
      .replace(prompt, "")
      .split("\n")[0]
      .trim();

    return generated || query;
  } catch (error) {
    console.error("Search term generation failed:", error);
    return query;
  }
}

async function processEmailBody(email: any): Promise<string> {
  const headers = email.payload?.headers || [];
  const subject =
    headers.find((h: any) => h.name === "Subject")?.value || "No Subject";
  const from =
    headers.find((h: any) => h.name === "From")?.value || "Unknown Sender";
  const date = headers.find((h: any) => h.name === "Date")?.value || "No Date";

  let body = "";

  function getBodyContent(part: any) {
    if (part.body?.data) {
      try {
        const content = Buffer.from(part.body.data, "base64").toString("utf-8");

        body += content.replace(/[\u0000-\u001F\u007F-\u009F]/g, "") + "\n";
      } catch (error) {
        console.error("Error decoding email body:", error);
        return "";
      }
    }

    if (Array.isArray(part.parts)) {
      part.parts.forEach((subPart: any) => getBodyContent(subPart));
    }
  }

  if (email.payload) {
    getBodyContent(email.payload);
  }
  body = body.trim();
  if (!body && email.snippet) {
    body = email.snippet;
  }

  if (!body) {
    body = "No content available";
  }

  const snippetLength = 200;
  const bodySnippet =
    body.length > snippetLength ? body.slice(0, snippetLength) + "..." : body;

  return `
Email from: ${from}
Subject: ${subject}
Date: ${date}
Content: ${bodySnippet}`.trim();
}

export async function POST(req: NextRequest) {
  try {
    const { query, token } = await req.json();

    console.log("Received Token:", token);

    if (!token) {
      return NextResponse.json(
        { message: "Authentication required" },
        { status: 401 }
      );
    }

    const { accessToken, refreshToken } = token;

    if (!refreshToken) {
      throw new Error("Refresh token is missing!");
    }

    // Set credentials
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: decodeURIComponent(refreshToken),
    });

    console.log("OAuth2 Credentials Before Refresh:", oauth2Client.credentials);

    // Check if refresh token exists before refreshing
    if (!oauth2Client.credentials.refresh_token) {
      throw new Error(
        "Refresh token is still missing after setting credentials."
      );
    }

    // Now refresh token
    const newToken = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(newToken.credentials);

    console.log("Refreshed Token:", newToken.credentials);

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    try {
      const searchQuery = await generateSearchQuery(query);
      console.log("Generated search query:", searchQuery);

      // First try exact phrase
      let response = await gmail.users.messages.list({
        userId: "me",
        q: `"${searchQuery}"`,
        maxResults: 15,
      });

      // If no results, try individual terms
      if (!response.data.messages) {
        console.log("No results with exact phrase, trying individual terms...");
        const searchTerms = searchQuery.split(" ");
        const orQuery = searchTerms.join(" OR ");
        response = await gmail.users.messages.list({
          userId: "me",
          q: orQuery,
          maxResults: 15,
        });
      }

      // If still no results, try even more flexible search
      if (!response.data.messages) {
        console.log("No results with OR query, trying more flexible search...");
        const searchTerms = searchQuery.split(" ");
        response = await gmail.users.messages.list({
          userId: "me",
          q: searchTerms[0], // Try just the first term
          maxResults: 15,
        });
      }

      console.log("Search response:", response.data);

      if (!response.data.messages) {
        return NextResponse.json({
          answer: "No emails found matching your query.",
          searchQuery,
        });
      }

      const emails = await Promise.all(
        response.data.messages.map(async (message) => {
          const email = await gmail.users.messages.get({
            userId: "me",
            id: message.id!,
            format: "full",
          });
          return processEmailBody(email.data);
        })
      );

      // Join all emails for context (limit to 2000 chars to avoid oversize prompts)
      const context = emails.join("\n---\n").slice(0, 2000);

      const analysisPrompt = `[INST] <<SYS>>
        Analyze these emails to answer: "${query}"
        Focus on:
        - Key information and relevant details
        - Important mentions and context
        - Direct answers to the query
        Keep response concise (3-5 sentences).
        <</SYS>>

        Email Context:
        ${context}

        Answer: [/INST]`;

      const response_text = await hf.textGeneration({
        model: "mistralai/Mistral-7B-Instruct-v0.2",
        inputs: analysisPrompt,
        parameters: {
          max_new_tokens: 500,
          temperature: 0.7,
        },
      });

      // Include a snippet of the email context in the response, e.g., first 500 characters
      return NextResponse.json({
        answer: response_text.generated_text,
        searchQuery,
        emailContextSnippet: context.slice(0, 500),
      });
    } catch (error: any) {
      console.error("Gmail API Error:", error);

      if (
        error.code === 403 &&
        error.errors?.[0]?.message?.includes("Metadata scope")
      ) {
        return NextResponse.json(
          {
            answer:
              "Authentication error: Please re-authenticate with full email access permissions.",
            error: "Insufficient OAuth scopes",
          },
          { status: 403 }
        );
      }

      return NextResponse.json(
        {
          answer: "An error occurred while searching your emails.",
          error: error.message,
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("Error:", error);
    return NextResponse.json(
      {
        message: "Internal server error",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
