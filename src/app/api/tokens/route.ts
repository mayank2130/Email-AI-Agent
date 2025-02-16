import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const accessToken = req.cookies.get("access_token")?.value || null;
  const refreshToken = req.cookies.get("refresh_token")?.value || null;
  console.log("From tokens api"+accessToken)
  console.log("From tokens api"+refreshToken)

  return NextResponse.json({
    accessToken,
    refreshToken,
  });
}
