import { NextResponse } from "next/server";
import { AppError } from "./app-error";

export { AppError };

/**
 * Réponse d'erreur uniforme. Les AppError exposent leur message ;
 * Les erreurs techniques restent opaques, y compris dans les logs : leur cause
 * peut contenir un préimage, un jeton RPC ou une chaîne de connexion.
 */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof AppError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[api] erreur interne");
  return NextResponse.json({ error: "Erreur interne — réessaye." }, { status: 500 });
}
