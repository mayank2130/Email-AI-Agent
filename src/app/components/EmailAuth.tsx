"use client";

import React, { useEffect, useState } from "react";
import EmailQuery from "./EmailQuery";

interface Token {
  accessToken: string;
  refreshToken: string;
}

export default function EmailAuth() {
  const [token, setToken] = useState<Token | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    
    const fetchToken = async () => {
      try {
        const res = await fetch("/api/tokens", { method: "GET" });
        if (res.ok) {
          const data = await res.json();
          setToken(data);
        }
      } catch (error) {
        console.error("Error fetching token:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchToken();
  }, []);

  if (loading) {
    return <div>Loading...</div>;
  }
  
  return token ? (
    <EmailQuery token={token} />
  ) : (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50">
      <div className="p-8 bg-white rounded-lg shadow-md">
        <h1 className="text-2xl font-bold mb-4">Email Assistant</h1>
        <p className="mb-4">
          Please log in with your Google account to access your emails.
        </p>
        <button
          onClick={() => (window.location.href = "/api/auth/google")}
          className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
        >
          Login with Google
        </button>
      </div>
    </div>
  );
}
