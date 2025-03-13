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

// Track previous search queries to avoid repetition
let previousQueries: Set<string> = new Set();

/** 
 * AgentPlan represents the LLM's decision after each step.
 * - action: "search" instructs to perform a Gmail search with the provided query.
 * - action: "refine" indicates that the agent wants to adjust the query based on current results.
 * - action: "final" means the agent is ready with the final answer.
 * - action: "sum" indicates that the agent is calculating a sum from emails.
 */
interface AgentPlan {
  action?: "search" | "refine" | "final" | "sum";
  query?: string;
  finalAnswer?: string;
  sumCategory?: string;  // What we're summing (flights, movies, etc.)
  final?: boolean; // For when agent returns "final": true
  // For when agent returns nested objects like {"search": {"query": "..."}}
  search?: { query: string };
  refine?: { query: string };
  sum?: { 
    category: string;
    pattern?: string;  // Optional regex pattern to match amounts
  };
}

/**
 * Calls the Anthropic API with retry logic for handling overloaded servers
 */
async function callAgentWithRetry(prompt: string, maxRetries = 3, forceFinal = false): Promise<AgentPlan> {
  let retries = 0;
  let lastError: any;

  while (retries < maxRetries) {
    try {
      console.log(`Calling agent with prompt (attempt ${retries + 1})...`);
      
      const response = await anthropic.messages.create({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 150,
        temperature: 0.7, // Slightly higher temperature for more variety
        system:
          "You are an agent that reasons about how to search emails and answer user queries using external tools. You can search emails, refine searches, calculate sums from monetary values in emails, and provide final answers. Your output must be a valid JSON object with 'action' (must be one of 'search', 'refine', 'sum', or 'final') and appropriate fields for each action type. When searching, use different search terms in each iteration if previous searches didn't yield useful results.",
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

      const textBlock = response.content.find((block) => block.type === "text");
      if (!textBlock || !("text" in textBlock)) {
        throw new Error("No text content in agent response");
      }
      
      console.log("Agent raw response:", textBlock.text.trim());
      const plan = parseAgentResponse(textBlock.text.trim());
      
      // Check if this is a repeated search query and force a different one
      if ((plan.action === "search" || plan.action === "refine") && plan.query) {
        if (previousQueries.has(plan.query.toLowerCase())) {
          console.log(`Query "${plan.query}" has been used before, requesting a different query`);
          // Try again with a modified prompt that explicitly asks for a different query
          return callAgentWithRetry(prompt + "\n\nIMPORTANT: You've already searched for this term. Please try a different search term or approach.", maxRetries - retries, forceFinal);
        }
        
        // Add this query to the set of previous queries
        previousQueries.add(plan.query.toLowerCase());
      }
      
      // If forceFinal is true, override the agent's action to be "final"
      if (forceFinal && plan.action !== "final") {
        console.log("Forcing action to 'final' as requested");
        plan.action = "final";
        if (!plan.finalAnswer) {
          plan.finalAnswer = "Based on the available emails, I couldn't find specific information about your query. Please try a different search term.";
        }
      }
      
      return plan;
      
    } catch (error: any) {
      lastError = error;
      
      // Check if this is an overloaded error (status 529)
      const isOverloaded = error.status === 529 || 
                          (error.error?.type === "overloaded_error") ||
                          (error.message && error.message.includes("Overloaded"));
      
      if (!isOverloaded) {
        // If it's not an overloaded error, don't retry
        console.error("Non-overload error from Anthropic API:", error);
        throw error;
      }
      
      retries++;
      if (retries >= maxRetries) {
        console.error(`Failed after ${maxRetries} retries:`, error);
        break;
      }
      
      // Exponential backoff with jitter
      const delay = Math.min(1000 * Math.pow(2, retries) + Math.random() * 1000, 10000);
      console.log(`Anthropic API overloaded. Retrying in ${Math.round(delay/1000)} seconds...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // If we've exhausted retries, return a final answer
  console.log("Exhausted retries, returning final answer");
  return {
    action: "final",
    finalAnswer: "I'm having trouble processing your request. Based on the available information, I couldn't determine a specific answer."
  };
}

/**
 * Parses the agent's response text into a structured AgentPlan object
 */
function parseAgentResponse(responseText: string): AgentPlan {
  try {
    const plan: AgentPlan = JSON.parse(responseText);
    console.log("Parsed agent plan:", plan);
    return plan;
  } catch (error) {
    throw new Error("Failed to parse agent response as JSON: " + responseText);
  }
}

/**
 * callAgent sends the current context (user query and any current email results)
 * to the LLM and instructs it to decide the next action.
 * If forceFinal is true, the prompt instructs the agent to produce a final answer.
 */
async function callAgent(
  userQuery: string,
  emailBatch?: string[],
  forceFinal: boolean = false,
  iteration: number = 1
): Promise<AgentPlan> {
  let context = `User Query: "${userQuery}"\n`;
  
  // Add information about previous search attempts
  if (previousQueries.size > 0) {
    context += `\nPrevious search terms: ${Array.from(previousQueries).join(", ")}\n`;
  }
  
  if (emailBatch && emailBatch.length > 0) {
    const emailsList = emailBatch
      .map((email, idx) => `Email #${idx + 1}:\n${email}`)
      .join("\n\n---\n\n");
    context += `\nCurrent Email Results:\n${emailsList}\n`;
  } else {
    context += `\nNo email results have been retrieved yet.\n`;
  }

  let extraInstruction = "";
  if (forceFinal) {
    extraInstruction =
      "\nIMPORTANT: You must now provide a FINAL answer using the current email results. Do not ask for further search. Include the answer in the 'finalAnswer' field and set 'action' to 'final'.";
  } else if (iteration > 1) {
    extraInstruction = 
      `\nThis is iteration ${iteration}. If previous searches didn't yield useful results, try different search terms, synonyms, or related concepts. For example:
      - For "meeting": try "call", "appointment", "discussion", "sync", "conference", "zoom", "teams"
      - For "receipt": try "invoice", "payment", "bill", "transaction", "order"
      - For "travel": try "flight", "trip", "booking", "hotel", "reservation", "itinerary"
      
      Avoid repeating previous search terms. Be creative with alternatives.`;
  }

  const prompt = `
You are an intelligent email-search agent that uses external tools (Gmail search) to answer a user's query.
Based on the context provided, decide your next step by outputting a JSON object with the following keys:
- "action": must be one of "search", "refine", "sum", or "final".
  • "search": if you need to search Gmail for more data, include a "query" field with a concise search term, ideally one or two words that capture the essence of the user's request. For example, if the user is looking for information about a "prime video subscription," you might use "prime."
  • "refine": if the current results are insufficient, provide a more focused search query in the "query" field, also limited to one or two words. This could involve using synonyms or related terms, such as trying "appointment" instead of "meeting" or "invoice" instead of "receipt".
  • "sum": if the user is asking about total spending or costs, use this action to calculate a sum from the emails. Include a "category" field describing what to sum (e.g., "flights", "subscriptions").
  • "final": if you have enough information, provide a final concise answer in the "finalAnswer" field.
Do not include any extra text.

Context:
${context}
${extraInstruction}

What is your next step?
`.trim();

  console.log("Calling agent with prompt:\n", prompt);
  
  // Pass forceFinal to callAgentWithRetry
  return await callAgentWithRetry(prompt, 3, forceFinal);
}

/**
 * searchEmails queries Gmail using the provided search query and returns
 * an array of concise email summaries.
 */
async function searchEmails(gmail: any, query: string): Promise<string[]> {
  console.log(`Searching Gmail with query: "${query}"`);
  
  // Extract Gmail operators to preserve them
  const operators = query.match(/(newer_than|older_than|after|before|from|to|subject|in|has|is|label):[^\s]+/g) || [];
  const searchQuery = operators.length > 0 ? query : `"${query}"`;
  
  let response = await gmail.users.messages.list({
    userId: "me",
    q: searchQuery,
    maxResults: 8  // Reduced to get faster results
  });

  if (!response.data.messages) {
    // Try fallback if no results
    const cleanQuery = query.replace(/[():"]/g, ' ');
    const searchTerms = cleanQuery.split(' ')
      .filter(term => term.length > 1)  // Include shorter terms
      .join(' OR ');
    
    response = await gmail.users.messages.list({
      userId: "me",
      q: searchTerms,
      maxResults: 8
    });
  }

  if (!response.data.messages) {
    console.log("No messages found.");
    return [];
  }

  const processedIds = new Set<string>();
  const emails: string[] = [];
  
  // Process all emails from search results without relevance filtering
  for (const message of response.data.messages) {
    if (processedIds.has(message.id)) continue;
    processedIds.add(message.id);

    const email = await gmail.users.messages.get({
      userId: "me",
      id: message.id,
      format: "full"
    });

    const summary = parseEmailData(email.data);
    emails.push(summary);
    
    // Limit to 5 emails for efficiency
    if (emails.length >= 5) {
      break;
    }
  }

  console.log(`Found ${emails.length} emails from search`);
  return emails;
}

/**
 * parseEmailData extracts key information (sender, subject, date, snippet)
 * from a Gmail message.
 */
function parseEmailData(emailData: any): string {
  const headers = emailData.payload?.headers || [];
  const subject = headers.find((h: any) => h.name === "Subject")?.value || "No Subject";
  const from = headers.find((h: any) => h.name === "From")?.value || "Unknown Sender";
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
  body = body.trim() || emailData.snippet || "No content available";
  const snippet = body.length > 200 ? body.slice(0, 200) + "..." : body;

  const parsed = `From: ${from}\nSubject: ${subject}\nDate: ${date}\nContent: ${snippet}`;
  console.log("Parsed email data:", parsed);
  return parsed;
}

/**
 * Extracts and sums monetary values from emails based on a category
 */
function calculateSum(emails: string[], category: string): { total: number; currency: string; details: any[] } {
  console.log(`Calculating sum for category: ${category}`);
  
  // Define patterns for different categories
  const patterns: Record<string, RegExp[]> = {
    // Generic money pattern
    default: [/(?:₹|Rs\.?|INR|USD|\$)\s*([0-9,]+(?:\.[0-9]+)?)/gi],
    
    // Flight specific patterns
    flight: [
      /(?:total|amount|fare|price|cost)(?:[:\s])*(?:₹|Rs\.?|INR|USD|\$)\s*([0-9,]+(?:\.[0-9]+)?)/gi,
      /(?:₹|Rs\.?|INR|USD|\$)\s*([0-9,]+(?:\.[0-9]+)?)(?:[^0-9]|$)/gi
    ],
    
    // Subscription patterns
    subscription: [
      /(?:monthly|yearly|annual|subscription|plan|fee)(?:[:\s])*(?:₹|Rs\.?|INR|USD|\$)\s*([0-9,]+(?:\.[0-9]+)?)/gi,
      /(?:₹|Rs\.?|INR|USD|\$)\s*([0-9,]+(?:\.[0-9]+)?)(?:[^0-9]|$)/gi
    ]
  };
  
  // Use category-specific patterns or default to generic money pattern
  const categoryKey = Object.keys(patterns).find(key => 
    category.toLowerCase().includes(key.toLowerCase())
  ) || 'default';
  
  const relevantPatterns = patterns[categoryKey];
  
  // Track currency for consistency
  let dominantCurrency = '';
  const currencyCounts: Record<string, number> = {};
  
  // Store details for each match
  const details: any[] = [];
  let total = 0;
  
  emails.forEach(email => {
    const lines = email.split('\n');
    const from = lines.find(l => l.startsWith('From:'))?.substring(6) || '';
    const subject = lines.find(l => l.startsWith('Subject:'))?.substring(9) || '';
    const date = lines.find(l => l.startsWith('Date:'))?.substring(6) || '';
    const content = lines.find(l => l.startsWith('Content:'))?.substring(9) || '';
    
    // Combine relevant parts for searching
    const searchText = `${subject} ${content}`;
    
    // Try each pattern
    for (const pattern of relevantPatterns) {
      const matches = [...searchText.matchAll(pattern)];
      
      matches.forEach(match => {
        // Extract currency symbol
        const fullMatch = match[0];
        const currencySymbol = fullMatch.match(/₹|Rs\.?|INR|USD|\$/) || [''];
        const currency = currencySymbol[0];
        
        // Count currency occurrences to determine dominant currency
        currencyCounts[currency] = (currencyCounts[currency] || 0) + 1;
        
        // Extract and parse amount
        const amount = match[1].replace(/,/g, '');
        const parsedAmount = parseFloat(amount);
        
        if (!isNaN(parsedAmount)) {
          // Add to details
          details.push({
            from,
            subject,
            date,
            amount: parsedAmount,
            currency,
            text: fullMatch
          });
          
          // Add to total
          total += parsedAmount;
        }
      });
    }
  });
  
  // Determine dominant currency
  let maxCount = 0;
  for (const [currency, count] of Object.entries(currencyCounts)) {
    if (count > maxCount) {
      maxCount = count;
      dominantCurrency = currency;
    }
  }
  
  return {
    total,
    currency: dominantCurrency || '₹', // Default to rupees if no currency found
    details
  };
}

/**
 * agentSolveQuery orchestrates the iterative loop.
 * In each iteration, the agent (LLM) reviews the user query and current email results
 * and decides whether to search, refine the query, or finalize the answer.
 */
async function agentSolveQuery(userQuery: string, gmail: any): Promise<{ answer: string; emails: string[] }> {
  let currentEmails: string[] | undefined = undefined;
  let allProcessedEmails: string[] = []; // Keep track of all emails we've seen
  
  // Reset previous queries for this new user query
  previousQueries = new Set();
  
  console.log("Starting agent loop with query:", userQuery);
  
  let iterations = 0;
  const maxIterations = 5;
  let plan: AgentPlan;

  while (iterations < maxIterations) {
    // On the last iteration, force the agent to finalize.
    const forceFinal = iterations === maxIterations - 1;
    if (forceFinal) {
      console.log("Forcing final answer in agent prompt (iteration", iterations + 1, ")");
    }
    
    // If we have no relevant emails but have processed some, use those as a fallback
    if ((!currentEmails || currentEmails.length === 0) && allProcessedEmails.length > 0) {
      console.log("No relevant emails found, using all processed emails as fallback");
      currentEmails = allProcessedEmails.slice(0, 5); // Use up to 5 emails
    }
    
    // Pass the iteration number to callAgent
    plan = await callAgent(userQuery, currentEmails, forceFinal, iterations + 1);
    console.log(`Iteration ${iterations + 1} - Current agent plan:`, plan);

    // Handle various response formats from the agent
    
    // Handle case where agent returns "final": true instead of "action": "final"
    if (plan.final === true && !plan.action) {
      console.log("Converting 'final: true' to 'action: final'");
      plan.action = "final";
    }
    
    // Handle case where agent returns {"search": {"query": "..."}} instead of {"action": "search", "query": "..."}
    if (plan.search && plan.search.query && !plan.action) {
      console.log("Converting '{search: {query: ...}}' to '{action: search, query: ...}'");
      plan.action = "search";
      plan.query = plan.search.query;
    }
    
    // Handle case where agent returns {"refine": {"query": "..."}} instead of {"action": "refine", "query": "..."}
    if (plan.refine && plan.refine.query && !plan.action) {
      console.log("Converting '{refine: {query: ...}}' to '{action: refine, query: ...}'");
      plan.action = "refine";
      plan.query = plan.refine.query;
    }

    // Handle case where agent returns {"final": {"finalAnswer": "..."}} instead of {"action": "final", "finalAnswer": "..."}
    if (plan.final && typeof plan.final === 'object' && 'finalAnswer' in plan.final && !plan.action) {
      console.log("Converting '{final: {finalAnswer: ...}}' to '{action: final, finalAnswer: ...}'");
      plan.action = "final";
      plan.finalAnswer = (plan.final as any).finalAnswer;
    }

    if (plan.action === "search" || plan.action === "refine") {
      if (!plan.query) {
        throw new Error("Agent plan missing 'query' for search/refine action.");
      }
      console.log(`Agent action "${plan.action}" with query: "${plan.query}"`);
      const searchResults = await searchEmails(gmail, plan.query);
      
      // Store all emails we find, even if they're not considered "relevant"
      allProcessedEmails = [...allProcessedEmails, ...searchResults];
      
      // If we found no relevant emails but have raw results, use those
      if (searchResults.length === 0 && allProcessedEmails.length > 0) {
        currentEmails = allProcessedEmails.slice(0, 5);
        console.log("No relevant emails found in search, using fallback emails");
      } else {
        currentEmails = searchResults;
      }
      
      console.log("Current email summaries:", currentEmails);
    } else if (plan.action === "sum") {
      if (!currentEmails || currentEmails.length === 0) {
        // If no emails yet, first search for relevant emails
        console.log("No emails to sum, searching first...");
        const searchQuery = plan.sumCategory || plan.query || "default";
        currentEmails = await searchEmails(gmail, searchQuery);
        console.log(`Found ${currentEmails.length} emails for summing`);
      }
      
      // Extract the category from the plan
      const category = plan.sumCategory || 
                      (plan.sum && plan.sum.category) || 
                      "default";
      
      // Calculate the sum
      const sumResult = calculateSum(currentEmails, category);
      
      // Format the result for the next iteration
      const formattedSum = `Based on the emails, the total ${category} amount is ${sumResult.currency}${sumResult.total.toLocaleString('en-IN', {maximumFractionDigits: 2})}`;
      
      // Add the sum result to the emails for context in the next iteration
      currentEmails.unshift(`CALCULATED SUM: ${formattedSum}`);
      
      console.log(formattedSum);
    } else if (plan.action === "final") {
      if (plan.finalAnswer) {
        console.log("Agent finalized answer:", plan.finalAnswer);
        return {
          answer: plan.finalAnswer,
          emails: currentEmails || [] // Return the relevant emails with the answer
        };
      } else {
        throw new Error("Agent returned final action but no finalAnswer provided.");
      }
    } else {
      throw new Error("Unrecognized action from agent: " + plan.action);
    }
    iterations++;
  }

  // If we reach max iterations but have emails, return those with a generic message
  if (allProcessedEmails.length > 0) {
    return {
      answer: "I found some potentially relevant emails but couldn't determine a specific answer. Please review these emails for the information you're looking for.",
      emails: allProcessedEmails.slice(0, 5)
    };
  }

  throw new Error("Agent failed to provide a final answer after multiple iterations.");
}

/**
 * Next.js API POST handler – the main entry point.
 */
export async function POST(req: NextRequest) {
  try {
    const { query, token } = await req.json();
    console.log("Received Token:", token);
    if (!token) {
      return NextResponse.json({ message: "Authentication required" }, { status: 401 });
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
      throw new Error("Refresh token is still missing after setting credentials.");
    }
    const newToken = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(newToken.credentials);
    console.log("Refreshed Token:", newToken.credentials);

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    console.log("Starting to solve user query through agent...");

    // Use the iterative agent to solve the user query.
    const result = await agentSolveQuery(query, gmail);
    console.log("Final result:", result);

    return NextResponse.json({
      answer: result.answer,
      emails: result.emails
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
        answer: "An error occurred while processing your query.",
        error: error.message,
      },
      { status: 500 }
    );
  }
}
