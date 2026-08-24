import { NextResponse } from "next/server";
import { AppError } from "./app-error";

export { AppError };

/**
 * Réponse d'erreur uniforme. Les AppError exposent leur message ;
 * toute autre erreur est loggée côté serveur et masquée (pas de fuite d'infra).
 */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof AppError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[api]", err);
  return NextResponse.json({ error: "Erreur interne — réessaye." }, { status: 500 });
}
