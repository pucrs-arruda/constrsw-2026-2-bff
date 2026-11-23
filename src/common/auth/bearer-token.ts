import type { Request } from 'express';

/**
 * **Ponto de encaixe com o `modules/auth`, que ainda não existe.**
 *
 * Pelo AD-4 e AD-6, o browser nunca carrega token: o BFF faz o login, guarda a sessão num cookie
 * httpOnly SameSite=Lax e propaga `Authorization: Bearer` para os contextos. Quem traduz
 * cookie → token é o `modules/auth`, que não pertence a nenhum grupo e por isso não foi escrito.
 *
 * Até ele existir, esta função lê o token de duas fontes, nesta ordem:
 *
 * 1. `req.bearerToken`, onde o futuro guard de sessão deve depositá-lo — é o contrato que
 *    propomos, e a única linha que o `modules/auth` precisa respeitar para este módulo funcionar
 *    sem alteração;
 * 2. o header `Authorization` da própria requisição, que mantém o módulo testável e utilizável
 *    pelo Swagger enquanto o login não existe.
 *
 * Quando o `modules/auth` entrar, o item 2 deve cair — aceitar token do browser contraria o AD-4.
 */
export function bearerTokenOf(request: Request): string | undefined {
	const fromSession = (request as Request & { bearerToken?: string }).bearerToken;
	if (fromSession) {
		return fromSession;
	}

	const header = request.headers.authorization;
	if (header?.toLowerCase().startsWith('bearer ')) {
		return header.slice('bearer '.length).trim();
	}

	return undefined;
}
