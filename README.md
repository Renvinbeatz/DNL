# Diário da NØVA

Site estático com Supabase para cadastros, resultados, cupons e comunicados. Jogadores acessam pelo ID do Free Fire. Administradores usam e-mail e senha do Supabase Auth, com associação em `admin_users` e sessão válida conferidas no banco. Não há etapa de autenticador no painel.

## Estado da segurança

A auditoria de 26/10/2026 confirmou as proteções anteriores no Supabase e os cabeçalhos no site publicado. As novas correções de logout, dados residuais, permissões de escrita e máscara de IDs estão preparadas localmente; nenhuma escrita remota ou publicação foi realizada nesta auditoria. O relatório atual está em `security/AUDITORIA-2026-10-26.md`; o relatório anterior foi preservado em `security/RELATORIO-SEGURANCA.md`.

## Ganhos da liga

A aba **Ganhos** soma **R$ 6,00 por participação registrada e por inscrição paga de não participante**, desconta o mesmo total de premiações do painel e os gastos com anúncios. Anúncios e não participantes são lançamentos acumulativos salvos no Supabase: R$ 80 + R$ 120 totalizam R$ 200; 3 + 2 não participantes totalizam 5 inscrições e R$ 30 de receita adicional. Não participantes não geram jogadores nem resultados no ranking. O saldo pode ser negativo e a aba exibe os 50 lançamentos mais recentes, mantendo todos salvos.

Para quem já ativou a aba Ganhos, aplicar apenas `supabase/update-finance-entries.sql` e publicar o frontend atualizado. O gasto antigo vira um lançamento inicial preservado. Para a primeira instalação, usar `supabase/enable-admin-finances.sql`, que inclui as duas migrações financeiras. Ambos são gerados por `npm run package:finances` e exigem as proteções 01–07. Não reaplicar o pacote completo de segurança. Fórmulas e instruções estão em [supabase/GANHOS.md](supabase/GANHOS.md). A aplicação e publicação continuam manuais.

## Aplicar as correções da auditoria de 26/10/2026

Publicar primeiro o frontend atualizado, com instalação pelo lockfile e build em `dist`. Depois, no projeto que já recebeu as migrações 01–07, executar **somente `security/audit-fixes-2026-10-26.sql`** no SQL Editor, após conferir backup. A migração 08 restringe escritas diretas de partidas/totais e corrige a máscara de IDs curtos; não altera os dados existentes. O novo frontend cadastra jogadores enviando apenas nick e ID, deixando os valores iniciais para o banco.

O banco passa a exigir as funções administrativas para alterar partidas e atualizar os totais juntos. Status e medalhas continuam editáveis no painel. O logout agora solicita a revogação antes da limpeza da credencial, descarta respostas antigas e remove os dados privados do navegador. A dependência de testes Undici foi atualizada no lockfile.

Ainda é necessário revisar manualmente o cadastro público de contas Auth, proteção contra senhas vazadas e os limites reais de autenticação. O contador de 15 segundos continua sendo uma proteção da interface, contornável pela API. O acesso por ID e a administração sem segundo fator foram preservados conforme solicitado. Não reaplicar o pacote completo em produção; o relatório detalha a ordem e os testes após publicar.

## Atualizar um site que já recebeu as seis migrações anteriores

Executar **somente** `security/remove-admin-mfa.sql` no SQL Editor do projeto correto e publicar o novo frontend, com `app.js` e `index.html` atualizados. Esse arquivo contém a migração `20261021044448_security_hardening_07.sql`: retira a exigência de `aal2`, preservando associação administrativa, revogação e validade máxima da sessão. É possível executar a atualização incremental novamente sem duplicar dados.

Não reaplicar o pacote completo em um banco que já recebeu as seis migrações. Se o pacote anterior ainda não foi aplicado, usar a instalação completa abaixo: `security/apply-security.sql` já inclui todas as oito migrações e mantém acesso administrativo sem segundo fator. Os três pacotes são gerados por `npm run package:security`. Após aplicar somente a remoção de MFA, também aplicar a atualização incremental 08 indicada acima.

A alteração não apaga fatores já cadastrados na conta Supabase: o painel deixa de solicitá-los e de exigir o segundo fator nas permissões do banco. A validação de e-mail/senha continua obrigatória.

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
4. Alternativamente, usar Supabase CLI autenticada e aplicar as oito migrações em ordem. Escolher esse caminho **ou** o pacote manual: não executar os dois. O SQL Editor não registra automaticamente as versões no histórico do CLI; antes de adotar CLI depois de uma aplicação manual, reconciliar esse histórico. Nunca marcar migrações como aplicadas sem verificar seu efeito.
5. No Supabase, conferir que `nova_private` não está entre os esquemas expostos pela Data API. Não adicionar concessões públicas ou políticas `USING (true)` a mensagens, sessões ou jogadores para contornar erros de login.
6. Confirmar a conta administrativa existente em Supabase Auth e sua linha em `public.admin_users`. Não criar associação administrativa com base em metadados editáveis pelo usuário. Configurar proteção de senhas, limites de Auth, recuperação de conta e cadastro público de contas conforme a operação da organização.
7. Na Vercel, usar o projeto `novaleague` da equipe autorizada. Publicar este repositório com `npm run build` e saída `dist`; `vercel.json` contém essas definições e os cabeçalhos. Não publicar a raiz como pasta estática. Instalação com `npm ci --ignore-scripts` é compatível com o build, evitando scripts de instalação desnecessários.
8. Validar primeiro a nova publicação e então o domínio `https://novaleague.vercel.app/`. Entrar com e-mail e senha de uma conta administrativa: o painel deve abrir diretamente, sem QR ou código do autenticador. Uma conta autenticada sem associação administrativa deve ser recusada. O acesso administrativo pode ser aberto com Ctrl+Shift+A ou cinco cliques na marca.

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

Verificar também, pela aplicação, acesso por ID, mensagens de dois cadastros diferentes, marcação de leitura, ranking, criação/edição/exclusão de uma partida de teste e login administrativo por e-mail/senha. Conferir no domínio os cabeçalhos CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` e `Referrer-Policy: no-referrer`. Rodar os advisors novamente. Um `403` de tabela protegida para visitante é esperado; não remover RLS para corrigir isso.

Há uma duplicata histórica identificada na auditoria. A migração não a apaga. Sua revisão exige confirmar o resultado correto antes de alterar totais reais.

## Limites e manutenção

O ranking tem categorias por kills, ganhos e Booyahs. Na aba Booyahs, cada resultado de posição 1 soma um Booyah e cada posição 2 soma um Top 2, mostrado em texto menor. A ordem usa Booyahs, Top 2, kills e nome; o identificador interno desempata casos idênticos. Quem possui apenas Top 2 também aparece, abaixo dos jogadores com Booyahs. Os totais são recalculados com os resultados carregados, sem nova tabela ou migração SQL. Editar ou excluir resultados atualiza a contagem na próxima atualização de dados. Registros repetidos com o mesmo identificador são contados uma só vez; eventuais duplicatas históricas com identificadores diferentes continuam exigindo a revisão já indicada na auditoria.

Desde 26/10/2026, uma tentativa recusada de login administrativo ou de jogador inicia uma espera de 15 segundos na interface. Os dois formulários mostram a contagem no botão e recusam novos envios até o prazo terminar. O prazo é compartilhado no mesmo navegador, persiste ao recarregar e sincroniza entre abas; trocar o e-mail, a senha ou o ID não reinicia nem contorna a espera. Os campos continuam editáveis para corrigir os dados enquanto o botão está bloqueado. Falhas de conexão não são tratadas como credenciais erradas.

Esse intervalo é aplicado no frontend e armazena somente o horário de liberação em `localStorage`, sem credenciais. Ele não substitui os limites do Supabase/banco e pode ser contornado por clientes que chamem as APIs diretamente, outro navegador ou alteração do armazenamento local. Limites já existentes no serviço podem impor espera maior. Para publicar esta mudança, atualizar `app.js`, `index.html` e `styles.css`; não há nova migração SQL.

Tokens de jogadores ficam nesta aba, expiram em sete dias com renovação limitada a trinta dias e são guardados no banco como hash. Fechar a aba normalmente exige informar o ID outra vez. O painel administrativo encerra no cliente após quinze minutos sem interação e o banco impõe duração máxima de oito horas à sessão de Auth.

A consulta de comunicados do jogador retorna até 500 mensagens recentes; a atualização do frontend limita cada histórico paginado a 20.000 registros. Ranking, estatísticas, prêmios e medalhas são públicos; IDs ficam parcialmente ocultados nas projeções. A ocultação não torna nick e resultados anônimos.

Há limites de acesso no banco, mas não um limitador por IP na borda. Configuração de CAPTCHA, proteção contra senhas vazadas e atualização da infraestrutura PostgreSQL são tarefas do provedor ainda pendentes. A trilha privada de auditoria registra metadados; sua retenção deve ser definida pela organização. O relatório detalha todos os limites e o que foi efetivamente testado.

Para suporte, configurar opcionalmente `supportUrl` em `public-config.js` com o endereço oficial `https://wa.me/NUMERO`. Sem configuração, o site orienta procurar a organização.
