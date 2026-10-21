# Diário da NØVA

Site estático com Supabase para cadastros, resultados, cupons e comunicados. Jogadores acessam pelo ID do Free Fire. Administradores usam Supabase Auth com associação em `admin_users` e segundo fator TOTP obrigatório no banco.

## Estado da segurança

As correções desta entrega estão no código e nas migrações, **ainda não implantadas**. Supabase recusou escritas persistentes com `Invalid or expired requestState`; Vercel recusou acesso à equipe do projeto com `403`. O relatório completo está em `security/RELATORIO-SEGURANCA.md`.

O acesso por ID não comprova identidade. Quem conhece um ID cadastrado pode ler as informações e comunicados desse cadastro. Essa característica foi mantida por solicitação do proprietário. Não enviar informações confidenciais por esse fluxo.

## Desenvolvimento e validação

Usar Node.js 22 ou posterior e npm. A instalação usa versões fixadas no lockfile:

```powershell
npm ci --ignore-scripts
npm test
npm run build
npm run package:security
npm run audit:dependencies
npm run serve
```

O site local fica em `http://127.0.0.1:4173`. O servidor só entrega os sete arquivos públicos permitidos. `dist` contém o pacote de publicação. Testes não usam dados reais nem se conectam ao Supabase remoto. `tests/legacy-schema.sql` é exclusivamente uma fixture de testes.

`public-config.js` contém uma URL e uma chave **pública** `publishable`, não um segredo. Não colocar `service_role`, `sb_secret`, senha do banco ou tokens de integração em arquivos do site. `.env.example` é apenas um exemplo; o site estático não lê `.env` automaticamente.

## Implantação do banco e do site

1. Confirmar o projeto Supabase `aqvyehkrbjttvdirtjzd` e criar/conferir backup recuperável antes da migração. Essas migrações dependem do esquema auditado e não são um instalador para banco vazio.
2. Fazer a aplicação em janela de manutenção. O frontend antigo usa permissões/assinaturas que serão removidas; publicar somente um dos lados interrompe fluxos. A migração invalida tokens antigos, exigindo novo acesso dos jogadores por ID.
3. Gerar `security/apply-security.sql` com `npm run package:security`. Abrir o SQL Editor do projeto correto com uma conta autorizada e executar o arquivo completo uma única vez. Ele contém `BEGIN`/`COMMIT`; em caso de erro, a transação não deve ser tratada como aplicação parcial bem-sucedida. Não reaplicar o pacote após sucesso.
4. Alternativamente, usar Supabase CLI autenticada e aplicar as seis migrações em ordem. Escolher esse caminho **ou** o pacote manual: não executar os dois. O SQL Editor não registra automaticamente as seis versões no histórico do CLI; antes de adotar CLI depois de uma aplicação manual, reconciliar esse histórico. Nunca marcar migrações como aplicadas sem verificar seu efeito.
5. No Supabase, conferir que `nova_private` não está entre os esquemas expostos pela Data API. Não adicionar concessões públicas ou políticas `USING (true)` a mensagens, sessões ou jogadores para contornar erros de login.
6. Confirmar a conta administrativa existente em Supabase Auth e sua linha em `public.admin_users`. Não criar associação administrativa com base em metadados editáveis pelo usuário. Configurar proteção de senhas, limites de Auth, recuperação de MFA e cadastro público de contas conforme a operação da organização.
7. Na Vercel, usar o projeto `novaleague` da equipe autorizada. Publicar este repositório com `npm run build` e saída `dist`; `vercel.json` contém essas definições e os cabeçalhos. Não publicar a raiz como pasta estática. Instalação com `npm ci --ignore-scripts` é compatível com o build, evitando scripts de instalação desnecessários.
8. Validar primeiro a nova publicação e então o domínio `https://novaleague.vercel.app/`. No primeiro acesso do administrador, cadastrar um autenticador e confirmar o código TOTP. O painel não deve liberar acesso apenas com a senha. O acesso administrativo pode ser aberto com Ctrl+Shift+A ou cinco cliques na marca.

O endereço Supabase também está na CSP de `index.html` e `vercel.json`. Ao trocar de projeto, alterar os três arquivos de configuração e revisar o esquema e as migrações para o destino. Chaves de outro projeto não transferem os dados, permissões ou contas de Auth.

## Conferência depois da aplicação

Executar como responsável pelo banco, em consulta somente de leitura:

```sql
SELECT to_regnamespace('nova_private') AS private_schema;
SELECT n.nspname, p.proname
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prosecdef;
SELECT to_regprocedure('public.mark_message_read(uuid,uuid)') AS legacy_idor;
SELECT conrelid::regclass AS entity, conname, convalidated
FROM pg_constraint
WHERE conname IN ('player_input_valid','match_input_valid','coupon_input_valid','message_input_valid');
```

Esperado: esquema privado existe; nenhuma função pública `SECURITY DEFINER`; assinatura antiga de IDOR inexistente; quatro constraints validadas. As implementações privilegiadas ficam no esquema privado, com verificação própria e permissões explícitas.

Verificar também, pela aplicação, acesso por ID, mensagens de dois cadastros diferentes, marcação de leitura, ranking, criação/edição/exclusão de uma partida de teste e login administrativo com MFA. Conferir no domínio os cabeçalhos CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` e `Referrer-Policy: no-referrer`. Rodar os advisors novamente. Um `403` de tabela protegida para visitante é esperado; não remover RLS para corrigir isso.

Há uma duplicata histórica identificada na auditoria. A migração não a apaga. Sua revisão exige confirmar o resultado correto antes de alterar totais reais.

## Limites e manutenção

Tokens de jogadores ficam nesta aba, expiram em sete dias com renovação limitada a trinta dias e são guardados no banco como hash. Fechar a aba normalmente exige informar o ID outra vez. O painel administrativo encerra no cliente após quinze minutos sem interação e o banco impõe duração máxima de oito horas à sessão de Auth.

A consulta de comunicados do jogador retorna até 500 mensagens recentes; a atualização do frontend limita cada histórico paginado a 20.000 registros. Ranking, estatísticas, prêmios e medalhas são públicos; IDs ficam parcialmente ocultados nas projeções. A ocultação não torna nick e resultados anônimos.

Há limites de acesso no banco, mas não um limitador por IP na borda. Configuração de CAPTCHA, proteção contra senhas vazadas e atualização da infraestrutura PostgreSQL são tarefas do provedor ainda pendentes. A trilha privada de auditoria registra metadados; sua retenção deve ser definida pela organização. O relatório detalha todos os limites e o que foi efetivamente testado.

Para suporte, configurar opcionalmente `supportUrl` em `public-config.js` com o endereço oficial `https://wa.me/NUMERO`. Sem configuração, o site orienta procurar a organização.
