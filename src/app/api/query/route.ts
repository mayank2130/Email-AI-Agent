import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const oauth2Client = new OAuth2Client({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: process.env.REDIRECT_URI,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generate dynamic parameters (searchQuery, extractionInstructions, aggregationMethod)
 * from the user’s natural language query.
 */
async function llmGenerateDynamicParams(
  query: string
): Promise<{
  searchQuery: string;
  extractionInstructions: string;
  aggregationMethod: string;
}> {
  await sleep(500); // simulate delay
  try {
    const response = await anthropic.messages.create({
      model: "claude-3-sonnet-20240229",
      max_tokens: 100,
      temperature: 0.2,
      system:
        "You are an email search expert. Convert the user's natural language query into a JSON object with these fields: " +
        "searchQuery (a simplified Gmail search query containing only subject or from: if and only if a direct name like from xyz is mentiond), extractionInstructions (instructions to extract a summary from an email), " +
        "and aggregationMethod (e.g. 'list' for collecting multiple email summaries).",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Convert this query: "${query}"`,
            },
          ],
        },
      ],
    });

    // Extract the text content and try to parse it as JSON.
    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || !("text" in textBlock)) {
      throw new Error("No text content in LLM response");
    }
    const generatedText = textBlock.text.trim();
    let dynamicParams;
    try {
      dynamicParams = JSON.parse(generatedText);
    } catch (_error) {
      // Fallback if the generated text is not valid JSON.
      dynamicParams = {
        searchQuery: generatedText || query,
        extractionInstructions: "Extract key details from the email content.",
        aggregationMethod: "list",
      };
    }
    return dynamicParams;
  } catch (error) {
    console.error("Dynamic parameter generation failed:", error);
    return {
      searchQuery: query,
      extractionInstructions: "Extract key details from the email content.",
      aggregationMethod: "list",
    };
  }
}

/**
 * Process the dynamic query by searching Gmail and extracting information from each email.
 */
async function processDynamicQuery(
  gmail: any,
  searchQuery: string,
  extractionInstructions: string,
  _aggregationMethod: string
): Promise<string[]> {
  const aggregatedResults: string[] = [];

  // Attempt search using the full query string.
  let response = await gmail.users.messages.list({
    userId: "me",
    q: `"${searchQuery}"`,
    maxResults: 15,
  });

  // If no messages found, try alternate search strategies.
  if (!response.data.messages) {
    const searchTerms = searchQuery.split(" ");
    const orQuery = searchTerms.join(" OR ");
    response = await gmail.users.messages.list({
      userId: "me",
      q: orQuery,
      maxResults: 15,
    });
  }
  if (!response.data.messages) {
    const searchTerms = searchQuery.split(" ");
    response = await gmail.users.messages.list({
      userId: "me",
      q: searchTerms[0],
      maxResults: 15,
    });
  }
  if (!response.data.messages) {
    return aggregatedResults; // return empty if nothing found
  }

  // Process each found email.
  for (const message of response.data.messages) {
    const email = await gmail.users.messages.get({
      userId: "me",
      id: message.id,
      format: "full",
    });
    const extractedInfo = await llmExtractInfo(
      email.data,
      extractionInstructions
    );
    // For a 'list' aggregation, simply collect each extracted summary.
    aggregatedResults.push(extractedInfo);
  }
  return aggregatedResults;
}

/**
 * Extract key information from an email using LLM extraction.
 */
async function llmExtractInfo(
  emailData: any,
  extractionInstructions: string
): Promise<string> {
  // Process email headers and body (similar to processEmailBody).
  const headers = emailData.payload?.headers || [];
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
      }
    }
    if (Array.isArray(part.parts)) {
      part.parts.forEach((subPart: any) => getBodyContent(subPart));
    }
  }
  if (emailData.payload) {
    getBodyContent(emailData.payload);
  }
  body = body.trim();
  if (!body && emailData.snippet) {
    body = emailData.snippet;
  }
  if (!body) {
    body = "No content available";
  }
  const snippetLength = 200;
  const bodySnippet =
    body.length > snippetLength ? body.slice(0, snippetLength) + "..." : body;

  // Construct a simple summary string.
  const emailContent = `Email from: ${from}\nSubject: ${subject}\nDate: ${date}\nContent: ${bodySnippet}`;

  // Build a prompt that combines the extraction instructions and the email content.
  const prompt = `${extractionInstructions}\n\n${emailContent}`;

  try {
    const llmResponse = await anthropic.messages.create({
      model: "claude-3-sonnet-20240229",
      max_tokens: 100,
      temperature: 0.2,
      system:
        "You are an assistant that extracts key information from email content based on provided instructions.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    });
    const textBlock = llmResponse.content.find(
      (block) => block.type === "text"
    );
    if (!textBlock || !("text" in textBlock)) {
      throw new Error("No text content in LLM extraction response");
    }
    return textBlock.text.trim();
  } catch (error) {
    console.error("LLM extraction failed:", error);
    // Fallback: return the raw email summary.
    return emailContent;
  }
}

/**
 * Next.js API POST handler – the main entry point.
 */
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
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: decodeURIComponent(refreshToken),
    });
    console.log("OAuth2 Credentials Before Refresh:", oauth2Client.credentials);
    if (!oauth2Client.credentials.refresh_token) {
      throw new Error(
        "Refresh token is still missing after setting credentials."
      );
    }
    const newToken = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(newToken.credentials);
    console.log("Refreshed Token:", newToken.credentials);

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Step 1: Generate dynamic parameters from the user query.
    const dynamicParams = await llmGenerateDynamicParams(query);
    console.log("Dynamic Parameters:", dynamicParams);
    const { searchQuery, extractionInstructions, aggregationMethod } =
      dynamicParams;

    // Step 2: Process the query using the dynamic parameters.
    const extractedEmailInfos = await processDynamicQuery(
      gmail,
      searchQuery,
      extractionInstructions,
      aggregationMethod
    );
    if (extractedEmailInfos.length === 0) {
      return NextResponse.json({
        answer: "No emails found matching your query.",
        searchQuery,
      });
    }

    // Step 3: Aggregate the email summaries into a single context.
    const context = extractedEmailInfos.join("\n---\n").slice(0, 2000);

    // Step 4: Analyze the aggregated email info using Anthropic to produce the final answer.
    const analysisResponse = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 500,
      temperature: 0.7,
      system:
        "Analyze the provided emails to answer the user's query. Focus on key information, relevant details, and direct answers. Keep the response concise (3-5 sentences).",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Query: "${query}"\n\nEmail Context:\n${context}`,
            },
          ],
        },
      ],
    });
    const textBlock = analysisResponse.content.find(
      (block) => block.type === "text"
    );
    if (!textBlock || !("text" in textBlock)) {
      throw new Error("No text content in analysis response");
    }

    return NextResponse.json({
      answer: textBlock.text,
      searchQuery,
      emailContextSnippet: context.slice(0, 500),
    });
  } catch (error: any) {
    console.error("Error:", error);
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
}
