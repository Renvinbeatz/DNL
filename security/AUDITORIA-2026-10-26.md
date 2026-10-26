# Auditoria de segurança — Diário da NØVA

**Data:** 26/10/2026. **Site:** https://novaleague.vercel.app/. **Projeto Supabase:** `aqvyehkrbjttvdirtjzd`.

**Resultado:** foram confirmados e corrigidos localmente cinco grupos de problemas: logout administrativo sem pedido de revogação, respostas e dados privados sobrevivendo à saída, alterações administrativas que contornavam a atualização dos totais, máscara incompleta de IDs curtos e uma dependência de testes vulnerável. Há configurações e limitações ainda pendentes, descritas abaixo. Esta auditoria não publicou o frontend nem alterou o banco de produção, conforme a preferência por aplicação manual.

O código público de `index.html` e `app.js` correspondia ao commit `0953b70`, desconsiderando apenas finais de linha. Assim, os problemas de frontend reproduzidos na versão anterior às correções também estavam no código entregue pelo domínio. As permissões e configurações do banco foram verificadas separadamente, por leitura.

## 1. Pesquisa e critérios usados

Aplicações produzidas com ajuda de IA continuam sujeitas às falhas tradicionais: permissões abertas, confiança excessiva na interface, sessões mal encerradas, entradas sem validação, dependências vulneráveis e operações que quebram regras de negócio. Esses temas orientaram os testes, com referência ao [OWASP Top 10:2025](https://top10.owasp.org/2025/) e ao [Web Security Testing Guide](https://owasp.org/projects/web-security-testing-guide).

O estudo primário [Spring 2026 GenAI Code Security Update, da Veracode](https://www.veracode.com/blog/spring-2026-genai-code-security/) relata falhas em aproximadamente 45% das tarefas de geração avaliadas no seu benchmark. Isso é um resultado daquele conjunto de tarefas e ferramentas de análise; **não significa que 45% deste site esteja vulnerável**, nem mede a probabilidade de invasão da NØVA.

Neste projeto, os problemas mais relevantes estavam nas transições de sessão e nas permissões das operações administrativas. Um layout funcionando e testes de caminhos felizes não demonstravam que o logout revogava a sessão ou que a API impedia alterações inconsistentes.

## 2. Escopo e métodos

Foram examinados o HTML, JavaScript, CSS, configuração da Vercel, dependências, saída de publicação, histórico Git, oito migrações locais e metadados do Supabase. Produção tinha as proteções equivalentes às migrações 01–07; a migração 08 foi criada nesta auditoria e permanece local.

| Ambiente | Trabalho realizado | Limites |
|---|---|---|
| Site e API públicos | 29 requisições controladas, mais duas leituras para comparar a versão publicada; HTTP, cabeçalhos, arquivos indevidos, RLS, JWT adulterado, esquema privado, CORS e configurações públicas de Auth | Somente GET, HEAD e OPTIONS. Sem tentativas de senha, criação de contas ou gravações |
| Supabase conectado | Leitura de permissões, políticas, funções, constraints, advisors e contagens agregadas de integridade; inventário de Storage e Edge Functions | Sem consulta ao conteúdo de mensagens, senhas, tokens ou dados identificáveis dos jogadores |
| PostgreSQL descartável | Migrações sobre dados fictícios, troca de papéis, IDOR, replay, expiração, adulteração de entradas, mass assignment e limites | PGlite executa SQL real; não reproduz toda a infraestrutura gerenciada, concorrência entre processos ou a rede do Supabase |
| Interface isolada | JSDOM, respostas de rede atrasadas, dados hostis, saída da conta, limpeza do DOM e envio repetido | Não equivale a um teste visual em todos os navegadores; JSDOM não valida a aplicação real da CSP pelo navegador |
| SDK de Auth | SDK instalado, armazenamento de sessão real da fixture e transporte HTTP simulado | Confirmou a emissão do pedido de logout sem usar credenciais reais |
| Dependências e arquivos | `npm audit`, busca heurística de segredos e inspeção dos arquivos de publicação | Busca por padrões não prova ausência de todo segredo possível; advisories só cobrem vulnerabilidades conhecidas |

Não foram executados testes de carga, indisponibilidade, engenharia social, envio de e-mail, coleta de dados pessoais ou exploração de infraestrutura de terceiros. As tentativas que exigem alterações aconteceram somente nas fixtures locais.

## 3. Falhas confirmadas e correções

### F01 — Logout administrativo apagava a credencial antes de revogar a sessão

**Prioridade alta. Corrigida no código; falta publicar.**

O fluxo removia `nova_admin_auth_v2` do `sessionStorage` antes de chamar `auth.signOut`. O SDK consulta esse armazenamento para obter o token que envia ao serviço de Auth. Sem ele, a chamada fazia limpeza local, mas não enviava o pedido de encerramento daquela sessão ao servidor.

**Reprodução:** uma sessão fictícia foi carregada no SDK real, com transporte interceptado. Ao executar `adminLogout`, nenhum pedido autenticado para `/logout?scope=local` era emitido. O teste falhou antes da mudança e passou depois.

**Impacto:** uma credencial previamente copiada poderia continuar utilizável após o usuário clicar em sair, enquanto o servidor considerasse a sessão válida. A checagem de associação administrativa e o limite de oito horas continuavam existindo; a falha não fornecia o token a um visitante.

**Correção:** o SDK agora recebe a oportunidade de revogar a sessão antes de limpar a credencial. A interface elimina os dados imediatamente. Falha de comunicação não é apresentada como logout concluído. A confirmação real da revogação no serviço deve ser feita após publicar, com uma conta de teste autorizada.

### F02 — Respostas atrasadas restauravam dados e estado após logout

**Prioridade média. Corrigida no código; falta publicar.**

Uma consulta iniciada enquanto havia sessão podia terminar depois da saída e escrever novamente em `state`. Foram reproduzidas a restauração do indicador administrativo e a volta de uma mensagem privada à memória e ao DOM. Alguns dados do jogador e opções de formulários permaneciam em elementos apenas ocultos. Uma falha durante atualização também não limpava todos os indicadores de sessão.

**Correção:** cada conjunto de consultas pertence agora à versão de sessão que o iniciou. Mudanças de sessão invalidam os resultados antigos. Os dados são publicados juntos somente ao terminar uma leitura válida. Saída, revogação e falhas de atualização limpam os dados e a autorização da interface; formulários administrativos e campos privados são esvaziados.

**Limite do impacto:** é uma exposição no navegador que já havia carregado os dados, especialmente relevante em dispositivo compartilhado. Alterar o indicador visual de administrador não elimina a RLS do servidor.

### F03 — Escritas diretas permitiam contornar a contabilidade das partidas

**Prioridade média, exige administrador válido. Corrigida na migração 08; falta aplicar.**

A RLS impedia visitantes e contas comuns de escrever, mas concedia ao administrador operações diretas sobre `partidas` e todos os campos de `jogadores`. Um `UPDATE` direto dos resultados podia alterar kills sem recalcular o total do jogador. Também era possível criar um jogador com um saldo inicial arbitrário por fora do formulário.

**Reprodução:** o teste usou uma sessão administrativa fictícia e tentou `UPDATE public.partidas SET kills=999`. A versão anterior aceitou a operação, contornando as funções que mantêm os totais. As mesmas tentativas por visitante e conta comum já eram recusadas.

**Correção:** a API de tabelas não pode inserir, atualizar ou excluir partidas diretamente. As funções administrativas que recalculam os totais continuam disponíveis. O cadastro direto de jogadores aceita somente nick e ID; alterações diretas ficam limitadas a nick, status e medalhas. O banco define os valores iniciais. Exclusão direta de jogadores foi retirada; o bloqueio preserva o histórico.

O frontend foi adaptado ao cadastro restrito. Não foi criada uma nova hierarquia de administradores: um administrador autorizado ainda pode editar resultados pelas funções previstas. A correção impede inconsistências por caminhos alternativos, não transforma um administrador malicioso em usuário sem poderes.

### F04 — IDs aceitos com três ou quatro dígitos eram retornados sem máscara

**Prioridade baixa; falha latente. Corrigida no frontend e na migração 08.**

A validação aceita IDs de 3–20 dígitos, mas a máscara mostrava os quatro primeiros. Na fixture, o cadastro `123` era retornado integralmente pelo ranking público. A correção mascara integralmente os IDs com até quatro dígitos e mantém o comportamento existente para os maiores. Partidas e ranking foram cobertos.

**Produção:** a consulta agregada encontrou zero jogadores com ID de até quatro dígitos. Não foi demonstrado vazamento desse caso nos dados atuais.

### F05 — Dependência de testes com advisories de segurança

**Prioridade média operacional; advisory máximo alto. Corrigida no lockfile.**

O primeiro `npm audit` encontrou `undici@8.11.2`, dependência indireta de `jsdom`, com três advisories, incluindo negação de serviço por tratamento de resposta HTTP. O [aviso oficial do Undici](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c) identifica as versões afetadas e a correção.

Foi atualizada somente essa dependência, para `8.12.3`, sem scripts de instalação. A conferência posterior retornou **zero vulnerabilidades conhecidas**. Trata-se de dependência de desenvolvimento/testes: ela não integra o pacote JavaScript publicado. Não foi encontrada exploração dessa falha no site público.

## 4. Pendências e riscos que continuam existindo

### P01 — A espera visual de 15 segundos é contornável fora da interface

**Prioridade alta para a proteção de tentativas administrativas; controle adicional pendente.**

O prazo fica no navegador. Um cliente que chama diretamente `player_login` ou o endpoint de senha do Supabase não executa esse contador. Foi demonstrado localmente que duas chamadas diretas de login por ID podem emitir sessões consecutivas, sem esperar 15 segundos. Para o login administrativo, não foi feita força bruta real; a ausência dessa regra no servidor decorre do fluxo direto de Auth e da configuração presente no código.

O banco limita logins por ID conhecido a 5/minuto e 30/hora, com limite global de 600/minuto. Isso não equivale a 15 segundos após cada erro. O Supabase também possui [limites próprios de Auth](https://supabase.com/docs/guides/auth/rate-limits), mas os valores configurados na conta não foram obtidos nesta auditoria; os padrões documentados não devem ser confundidos com a configuração efetiva.

**Próximo controle:** configurar os limites reais de Auth e proteção contra automação. Para exigir exatamente a regra de 15 segundos no servidor, é necessário desenhar e ativar um controle no caminho de autenticação que também cubra o endpoint direto. Colocar um contador em uma função auxiliar ou apenas proteger a Vercel deixa o Supabase direto contornável. Um limite apenas por e-mail/ID também permite bloqueio dirigido de usuários legítimos. Essa alteração de arquitetura/configuração não foi simulada como se estivesse implantada.

### P02 — Cadastro público de contas Auth habilitado sem necessidade do produto

**Prioridade média. Configuração remota pendente.**

`/auth/v1/settings` respondeu `disable_signup: false`, com confirmação de e-mail habilitada e login anônimo desabilitado. Os jogadores entram por ID e os administradores são cadastrados pela organização; o cadastro público de contas de e-mail amplia a superfície de abuso e consumo de recursos.

Desabilitar **Allow new users to sign up** no projeto correto, preservando as contas administrativas existentes. Conforme a [documentação de configuração do Supabase](https://supabase.com/docs/guides/auth/general-configuration), essa opção permite manter o login dos usuários existentes. Não foi criada uma conta para testar essa flag. Cadastro aberto **não concede associação em `admin_users`**: a tentativa de autopromoção foi recusada na fixture.

### P03 — Proteção contra senhas conhecidamente vazadas desligada

**Prioridade média. Configuração remota pendente.**

O advisor retornou `auth_leaked_password_protection`. Ativar a proteção quando disponível no plano e verificar a política real de senha no servidor. A [documentação atual](https://supabase.com/docs/guides/auth/password-security) informa disponibilidade dessa proteção nos planos Pro e superiores; esta auditoria não alterou nem contratou plano.

Não foram lidas ou testadas senhas existentes. Logo, o alerta não significa que a senha de um administrador esteja vazada. A restrição de tamanho no formulário também não comprova a política do servidor.

### P04 — Limites compartilhados podem afetar usuários legítimos

**Prioridade média, disponibilidade. Reproduzido localmente.**

O limite global de login é compartilhado. Ao representar um orçamento já esgotado na fixture, até um ID legítimo foi recusado. O teto de vinte sessões ativas também pode impedir acesso por um novo dispositivo. Como o ID não é segredo, alguém que o conhece pode emitir sessões e consumir a cota; isso não foi feito contra jogadores reais.

O limite protege o tamanho das tabelas e evita emissão ilimitada, mas não separa o proprietário do ID de um terceiro. Uma proteção por origem confiável, detecção de automação e regras de renovação precisam ser avaliadas junto com o modelo de acesso. Simplesmente expulsar a sessão mais antiga permitiria outro tipo de ataque, encerrando o acesso legítimo.

As consultas públicas de ranking/partidas têm paginação limitada, porém não consomem esses budgets de login. A ausência de um limitador próprio por origem deixa consumo abusivo de leituras como risco residual; não foi feito teste de carga para medir impacto ou limites da infraestrutura. Um controle somente no domínio da Vercel não cobre chamadas diretas ao domínio do Supabase.

### P05 — Uma duplicata histórica de resultado continua presente

**Prioridade média para a integridade do ranking. Revisão manual de dados pendente.**

A leitura agregada confirmou um grupo repetido pela combinação número/data/jogador. Não foram expostos os jogadores do grupo nem removidos registros. Os totais armazenados coincidem com a soma atual das partidas: zero divergências nessa conferência. Ainda assim, dois registros distintos do mesmo resultado podem contar duas vezes no ranking de Booyahs.

A organização precisa confirmar se são resultados legítimos ou uma duplicação antes de alterar dados. A prevenção de novas duplicações já existente passou nos testes; ela não decide retroativamente qual registro histórico é correto.

### Decisões de produto preservadas

**Acesso somente por ID:** não comprova identidade. Quem conhece um ID cadastrado pode abrir aquele diário e obter os dados disponibilizados a ele, inclusive advertências e comunicados, além de marcar mensagens como lidas. A correção de IDOR entre tokens não muda isso: um terceiro que conhece o outro ID pode solicitar uma sessão desse cadastro pelo fluxo normal. O risco foi mantido por escolha expressa do proprietário.

**Administração sem segundo fator:** a exigência de MFA continua removida, como solicitado. E-mail/senha, associação administrativa e sessão válida permanecem obrigatórios. Isso mantém maior dependência da proteção da senha, da recuperação de conta e dos limites de Auth.

**Tempos de sessão:** quinze minutos sem interação é um encerramento do cliente; o servidor impõe a janela máxima de oito horas à sessão administrativa. Tokens de jogador têm renovação de sete dias, limitada a trinta dias desde a criação. Esses controles não comprovam que a pessoa usando um ID seja seu titular.

### Melhorias operacionais, sem exploração demonstrada

Definir retenção e alertas para a trilha de auditoria; conferir backups com restauração de teste; verificar a versão recomendada de PostgreSQL pelo provedor e as configurações reais de Auth. Esses itens não foram certificados nesta execução. A trilha registra metadados das mutações, não prova que alertas estejam configurados.

O site ainda usa estilos inline autorizados pela CSP e CSS/fontes de terceiros. Reduzir essas dependências e adicionar integridade aos recursos estáveis pode fortalecer a política. Não foi demonstrado comprometimento desses recursos nem execução de JavaScript por eles.

## 5. Cobertura dos 19 tópicos solicitados

| Tema | Resultado e limite |
|---|---|
| 1. `.env` exposta | `.env` e `.env.local` retornaram 404. Build publica somente sete arquivos. A chave `publishable` é pública por definição; não é `service_role` |
| 2. Validação frontend | Casos de IDs, números, limites, envio repetido e conteúdo hostil testados. Pode ser ignorada por um cliente direto; não é a fronteira de segurança |
| 3. Validação backend | Constraints validadas e entradas de RPC adulteradas rejeitadas. F03 fecha operações alternativas que quebravam os totais |
| 4. SQL injection | Payloads de aspas, comentários, comandos e tipos inválidos não emitiram tokens nem alteraram dados; uso de parâmetros e SQL estático revisado |
| 5. Autenticação fraca | ID sem comprovação e MFA removido são decisões preservadas. Senhas vazadas e cadastro público: P02/P03 |
| 6. IDOR/BOLA | Tokens inválidos, UUID de outro jogador e troca de destinatário não permitiram ler/marcar mensagens de outro cadastro; conhecer seu ID ainda permite login por desenho |
| 7. Senhas direto no banco | O código não grava senhas em tabelas do aplicativo; usa Supabase Auth. Tokens de jogador são armazenados como hash. Senhas reais não foram inspecionadas |
| 8. Força bruta | Controles do banco testados, com bypass do contador visual e limites compartilhados demonstrados. Sem força bruta em contas reais |
| 9. Bloquear durante envio | Bloqueio de envio duplicado na interface testado. Duplicata e falha no meio de uma operação de partida não produzem gravação parcial na fixture |
| 10. CSRF | O app não usa cookies de autenticação enviados automaticamente. Operações protegidas exigem bearer/token explícito. Não foi identificado fluxo autenticado vulnerável a CSRF clássico no escopo |
| 11. Upload | Não existe fluxo de upload de arquivos do usuário; Storage sem buckets. Importação é texto estruturado com limites; entradas adulteradas testadas |
| 12. Revelação de informação | Sem dados reais nas evidências; respostas públicas usam projeções. F02 corrige resíduos no navegador e F04 a máscara curta. Metadados normais da API não foram tratados como segredo |
| 13. Dependências vulneráveis | Undici de testes atualizado; novo `npm audit` sem advisories. Não é garantia de ausência de falhas desconhecidas |
| 14. Tokens | Hash no banco, expiração, logout/replay e revogação de permissão testados. F01 corrige o pedido de encerramento administrativo |
| 15. Rate limit | Budgets existem, mas a espera visual não é uma regra do backend. Limitação por origem confiável e valores reais de Auth continuam pendentes |
| 16. Sensíveis expostos | Seis tabelas/views protegidas recusaram a leitura anônima. Busca heurística não encontrou segredos privados nos arquivos versionados/histórico examinados. Dados intencionalmente públicos continuam públicos |
| 17. SSRF | Nenhum endpoint de aplicação recebe URL para busca no servidor; nenhuma Edge Function instalada. Não foi inventado um alvo de SSRF inexistente |
| 18. Cookies inseguros | App usa `sessionStorage`, não cookies de login próprios. Isso evita esse problema específico, mas tokens continuam acessíveis a JavaScript da mesma origem se ocorrer XSS |
| 19. CORS | Vercel limita a origem do site; Supabase responde preflight com `*`, sem autorização por cookie. Isso não bypassa RLS nem substitui autenticação |

## 6. Outros vetores testados

| Método | Evidência |
|---|---|
| JWT adulterado com `alg: none` | Requisição pública recusada: HTTP 401, `PGRST301` |
| Troca de esquema via `Accept-Profile: nova_private` | HTTP 406, `PGRST106`; esquema privado não exposto pela Data API |
| Acesso direto com chave pública | `jogadores`, `partidas`, `mensagens`, `player_sessions`, `admin_users` e `public_jogadores`: HTTP 401/42501 |
| Função administrativa sem autenticação | `is_admin`: HTTP 401. As quatro funções de escrita foram recusadas localmente para `anon` e conta autenticada sem associação |
| Autopromoção por metadados e tabela de administradores | Metadados com papel admin não concederam permissão; inserção em `admin_users` recusada |
| Acesso ao contador e à auditoria | Sem privilégio de alterar budgets ou ler trilha/tokens, mesmo com a sessão administrativa do app |
| XSS armazenado, SVG, atributos, `javascript:`, iframe e DOM clobbering | Oito famílias de payloads permaneceram texto nas superfícies testadas; nenhum elemento/evento hostil foi criado |
| Replay e expiração de token | Tokens encerrados/expirados não leram mensagens; verificados os dois limites de expiração |
| Manipulação de JSON e números | Nulos, tipos errados, negativos, frações em inteiros, valores enormes, IDs inválidos, duplicatas e lote de 101 entradas rejeitados |
| Contabilidade e atomicidade | Repetição de partida e erro em uma entrada não deixaram um lote parcialmente gravado |
| Arquivos e publicação | Nove caminhos indevidos retornaram 404, incluindo `.git/config`, SQL, fixture e source map. Um caminho de subida foi normalizado pelo cliente HTTP: não constitui teste exaustivo de traversal bruto |
| Clickjacking, sniffing e transporte | Cabeçalhos de framing/CSP/nosniff presentes; HTTP redireciona com 308 para HTTPS; HSTS configurado |
| Corridas entre rede e logout | Respostas administrativas e mensagens atrasadas falhavam antes das correções e passaram a ser descartadas |

O teste de XSS também cobre dados exibidos na edição de partidas e nas opções de jogadores, não só os cartões públicos. A CSP real foi conferida pelos cabeçalhos; não foi usado um navegador para afirmar cobertura de todas as variações de execução.

## 7. Verificações e evidências

As evidências estão junto deste documento:

- `audit-public-2026-10-26.json`: 29 requisições, status, cabeçalhos e observações sem conteúdo dos registros.
- `audit-source-2026-10-26.json`: duas comparações do código publicado com o commit de referência, normalizando CRLF/LF.
- `audit-database-2026-10-26.json`: metadados de políticas, concessões, funções e advisors antes da migração 08.
- `audit-static-2026-10-26.json`: busca por padrões em 30 arquivos versionados e 84 blobs do histórico; dois itens binários/grandes ignorados; nenhuma ocorrência encontrada. Publicação contém exatamente os sete arquivos permitidos.
- `tests/adversarial.test.cjs`, `tests/database.test.cjs`, `tests/security.test.cjs`: reproduções locais e regressões.

O advisor não apontou tabelas abertas ou funções privilegiadas expostas. Os dois avisos informativos de RLS sem políticas são das tabelas privadas de auditoria e limites, intencionalmente sem acesso pelos clientes. Não se deve criar uma política permissiva para silenciá-los. O alerta de senha vazada permanece pertinente.

**Validação final:** 65 testes reportados pelo runner, build concluído, pacotes SQL gerados e `npm audit` sem vulnerabilidades conhecidas. O total do runner inclui dois agrupadores. Três casos descrevem limitações ainda presentes — acesso direto sem a espera visual, orçamento compartilhado e teto de sessões. A aprovação desses testes significa que o comportamento foi reproduzido, não que esses riscos foram eliminados.

Reprodução local, sem tocar em produção:

```powershell
npm ci --ignore-scripts
npm test
npm run build
npm run package:security
node scripts/security-static-audit.mjs
```

A consulta ao registro de advisories exige rede: `npm run audit:dependencies`. A verificação pública de leitura é separada: `node scripts/security-probe.mjs`. Ela usa somente os dois domínios explícitos deste projeto e não faz parte dos testes locais automáticos.

## 8. Aplicação manual

1. Revisar as alterações e confirmar backup recuperável do projeto correto.
2. **Publicar primeiro o frontend atualizado**, com o lockfile, usando `npm run build` e saída `dist`. O novo cadastro por nick/ID funciona tanto antes quanto depois da migração 08. O frontend antigo tenta enviar campos que a nova permissão bloqueará.
3. Como produção já possui as proteções 01–07, executar **somente `security/audit-fixes-2026-10-26.sql`**, como proprietário no SQL Editor. É a migração 08, transacional e repetível, sem alteração dos resultados existentes. Não reaplicar o pacote completo.
4. Desabilitar o cadastro público de Auth e revisar proteção de senha, recuperação de conta, limites e proteção contra automação. Nenhuma dessas configurações é ativada pelo SQL incremental.
5. Fazer uma conferência funcional com cadastro fictício controlado: login/logout administrativo, bloqueio de conta sem associação, cadastro individual/em lote, criação/edição/exclusão de partida, status, medalhas e acesso por ID. Confirmar também que uma sessão encerrada perdeu acesso no servidor.
6. Rever a duplicata histórica com a organização e planejar os controles pendentes P01/P04. Não apagar registros apenas por semelhança.

`security/apply-security.sql` contém agora as oito migrações para uma instalação que ainda esteja no esquema legado; não é um instalador para banco vazio. `security/remove-admin-mfa.sql` permanece exclusivamente a migração 07. Nenhum desses arquivos deve entrar na pasta pública.

Esta é uma auditoria delimitada à versão e às evidências acima, com correções verificadas localmente. Não certifica a ausência de toda vulnerabilidade nem substitui a validação da publicação e das configurações que continuam sob aplicação manual.
