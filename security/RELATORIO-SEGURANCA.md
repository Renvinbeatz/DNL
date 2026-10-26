# Relatório de segurança — Diário da NØVA

## Atualização de 21/10/2026 — acesso administrativo sem segundo fator

Por solicitação do proprietário, foi removida a exigência de duas etapas do painel. O frontend autentica por e-mail e senha e consulta `is_admin` antes de abrir o painel. A nova migração `20261021044448_security_hardening_07.sql` retira o requisito `aal2`, mantendo associação em `admin_users`, conferência da sessão no servidor, revogação e duração máxima de oito horas. Não há mais modal, QR, cadastro ou desafio de autenticador no código da aplicação. Fatores de contas reais não foram removidos.

O conjunto atualizado passou em 32 verificações locais, incluindo entrada administrativa sem segundo fator, recusa de contas sem permissão, sessão expirada ou de outro usuário e preservação das regras de mensagens e jogadores. A ausência do segundo fator faz a proteção administrativa depender da senha e da sessão do Supabase Auth; é a configuração solicitada.

Para quem já aplicou as seis migrações anteriores, foi preparado `security/remove-admin-mfa.sql`, contendo apenas a atualização incremental. Para quem ainda não as aplicou, `security/apply-security.sql` passou a incluir as sete migrações em ordem. Não reaplicar o pacote completo em banco já migrado. Ambos os pacotes são gerados das migrações pelo script de empacotamento.

Esta atualização foi feita somente no repositório, respeitando a preferência por implantação manual. O estado remoto não foi consultado nem alterado nesta etapa. As seções abaixo preservam o registro da auditoria de 10/10/2026; referências à obrigatoriedade de MFA e às seis migrações descrevem a versão anterior e são substituídas por esta atualização.

## Registro da auditoria de 10/10/2026

Data: 10/10/2026. Site: https://novaleague.vercel.app/. Projeto Supabase examinado: `aqvyehkrbjttvdirtjzd`. Escopo: código do site, esquema, permissões, funções e políticas do banco, dependências e cabeçalhos públicos.

## Resultado e situação real da entrega

As correções estão implementadas no repositório e verificadas localmente. **Ainda não estão aplicadas no Supabase de produção nem publicadas na Vercel.** Portanto, os problemas encontrados na produção continuam pendentes de implantação.

O Supabase aceita consultas de leitura, mas as tentativas de aplicar migrações e escritas persistentes retornaram `Invalid or expired requestState`. A conexão da Vercel retornou `403` para a equipe `contatovitinho02-2274s-projects`. É necessário renovar as conexões com acesso ao projeto correto ou executar a implantação manual descrita no `README.md`. Uma consulta final confirmou que o esquema `nova_private` ainda não existe no banco remoto. Nenhum cadastro, comunicado ou resultado real foi alterado nesta auditoria.

Após a confirmação de instalação do plugin Vercel, o acesso ao projeto foi verificado novamente: a API continuou retornando `403` para a mesma equipe. Não há CLI Vercel instalada neste ambiente para tentar uma sessão independente. A nova leitura do Supabase confirmou `nova_private` ausente e a assinatura antiga `mark_message_read(uuid,uuid)` ainda existente. Instalar o plugin não liberou o acesso necessário à publicação; nenhuma implantação foi iniciada.

Há seis migrações em `supabase/migrations`. O arquivo gerado `security/apply-security.sql` reúne todas em uma única transação para aplicação manual. O novo site e as migrações devem ser implantados juntos; publicar apenas o frontend não corrige as permissões do banco.

## Decisão sobre o acesso dos jogadores

Foi preservado o acesso somente pelo ID do Free Fire, conforme solicitado. Não foi adicionado e-mail ou senha aos jogadores. Essa entrada identifica o cadastro consultado, **mas não comprova quem é seu dono**. Qualquer pessoa que conheça um ID cadastrado consegue entrar como aquele jogador, consultar suas informações e mensagens e marcar os comunicados como lidos. Limites de acesso e tokens não eliminam essa característica.

O modelo pode servir ao uso definido pela organização, desde que os comunicados individuais sejam tratados como conteúdo acessível a quem souber o ID. A exposição não se limita a nick e ID: o painel também contém estatísticas, valores de prêmios, situação do cadastro e comunicados. Esses dados não devem receber informações que dependam de confidencialidade ou identificação comprovada do destinatário.

O público continua vendo ranking e resultados, incluindo nick, estatísticas, prêmios e medalhas. As consultas públicas novas ocultam parte dos IDs e não expõem advertências nem listas de leitura. Os identificadores alternativos são estáveis para vincular ranking e resultados; são pseudônimos técnicos, não anonimização completa. IDs de até quatro dígitos não são ocultados pela regra atual; a regra preserva os quatro primeiros caracteres.

## Principais achados confirmados

| Prioridade | Achado na versão anterior | Consequência | Tratamento preparado |
|---|---|---|---|
| Alta | Política de leitura pública em `mensagens` | Um visitante podia consultar também comunicados individuais diretamente na API, independentemente da tela | Remover leitura direta; RPC aceita token válido e retorna apenas mensagens do cadastro e globais |
| Alta | `mark_message_read(uuid, uuid)` aceitava identidade fornecida pelo cliente sem autorização | Marcar leitura em nome de outro cadastro | Remover essa assinatura; obter destinatário a partir do token no servidor |
| Alta | Leitura pública de jogadores/partidas e concessões por coluna | Ocultar o ID na tela não impedia sua consulta integral pela API | Revogar concessões de tabela e coluna, inclusive `PUBLIC`; publicar projeções com campos definidos |
| Alta | MFA do administrador tinha exceção para contas sem fator cadastrado | Permissão administrativa possível sem segundo fator | Exigir `aal2`, associação administrativa e sessão existente, não revogada e com idade inferior a oito horas |
| Média | Tokens de jogadores armazenados em texto original e renováveis sem limite absoluto | Banco comprometido poderia fornecer sessões utilizáveis; duração prolongada | Gerar 32 bytes aleatórios, guardar SHA-256, expirar sessões antigas e limitar validade |
| Média | Falta de limites duráveis nos endpoints dos jogadores | Abuso automatizado e consumo de recursos | Contadores no banco para entrada, atualização e leitura/marcação de comunicados |
| Média | Validação numérica incompleta e ausência de limites consistentes no banco | Valores negativos, inválidos, enormes ou entradas repetidas | Validação de formato/faixa no frontend, constraints e verificações nas funções administrativas |
| Média | JavaScript em eventos inline e interpolação em chamadas de botão | Risco de XSS em valores inseridos no contexto de código | Eventos delegados com ações permitidas, dados escapados, toast via `textContent` e CSP sem scripts inline |
| Média | Falta de cabeçalhos de proteção no site público | Ausência de bloqueio explícito de enquadramento e outras proteções do navegador | Configuração de CSP, anti-frame, `nosniff`, referrer e permissões na Vercel |
| Média | Resultado duplicado e concorrência de alterações de partidas | Pontuação e prêmios poderiam ficar inconsistentes | Serializar operações de partidas, bloquear registros durante edição e rejeitar novas duplicatas |
| Infraestrutura | Banco anunciado como PostgreSQL `17.6.1.166`; proteção contra senhas vazadas desativada no advisor | Atualização e configuração de Auth precisam de intervenção no serviço | Pendências explícitas; não foram alteradas pelo código |

As prioridades descrevem o impacto neste projeto; não foi calculada pontuação CVSS nem feita uma exploração de contas reais.

## Avaliação dos 19 tópicos solicitados

Em todas as linhas abaixo, “preparado” significa implementado e testado localmente, com implantação pendente. “Não identificado” significa que o mecanismo não foi encontrado no escopo examinado, não uma garantia sobre recursos externos.

| Nº | Tópico | Avaliação e tratamento |
|---|---|---|
| 1 | `.env` exposta | Não foi identificado arquivo `.env` nem chave privada no código original examinado. A URL e a antiga chave `anon` são públicas por finalidade. Foi usada uma chave `publishable`, com configuração pública explícita. `.env*` está ignorada, salvo o exemplo sem segredo; a publicação contém só sete arquivos permitidos. A autorização depende de RLS e RPCs, não de esconder a chave. |
| 2 | Validação no frontend | Preparados limites de ID, nick, e-mail, mensagem, cupom, lotes e valores numéricos. Rejeita vazio, negativos indevidos, valores não finitos e frações em campos inteiros. |
| 3 | Validação no backend | Preparadas constraints de jogadores, partidas, cupons e mensagens; limites de JSON/participantes, autorização e validação nas funções administrativas. O banco decide mesmo que a tela seja alterada. |
| 4 | SQL injection | Não foi identificado SQL dinâmico construído com entradas do usuário. Chamadas usam argumentos estruturados. Foram fixados `search_path`, nomes qualificados e validação. Um payload de injeção em ID é rejeitado nos testes. Não foi alegada uma exploração SQL comprovada na versão anterior. |
| 5 | Autenticação fraca | Acesso por ID mantido por decisão do usuário, com limitação descrita acima. Para administradores: Supabase Auth, associação em `admin_users`, MFA obrigatório e validação da sessão no banco. O atalho visual para abrir o painel não concede autorização. |
| 6 | IDOR | Preparado bloqueio de leitura direta dos comunicados e remoção da marcação baseada em ID fornecido pelo cliente. Sessão de um jogador não lê nem marca mensagens de outro. Saber o ID permite obter uma nova sessão daquele cadastro pelo modelo escolhido. |
| 7 | Senhas direto no banco | Não foram encontradas senhas de jogadores nem uma tabela de senhas próprias da aplicação. O administrador usa Supabase Auth; não foi consultado conteúdo de hashes ou credenciais. Senha limpa do campo após a tentativa, sem alteração de espaços significativos. |
| 8 | Força bruta | Entrada de jogadores limitada no banco. Administrador recebe respostas genéricas e exige MFA. Os limites do Supabase Auth e CAPTCHA no provedor precisam ser verificados/configurados no dashboard; o limitador de jogadores não protege o endpoint de senha do Supabase. |
| 9 | Bloquear durante envio | Preparado bloqueio de envios duplicados da mesma ação, desativação temporária dos controles e restauração em `finally`, inclusive após erro. Operações no banco têm transação e proteção contra duplicatas quando aplicável. |
| 10 | CSRF | A aplicação não autentica por cookies e não oferece rotas próprias que aceitem credenciais automaticamente do navegador. As operações usam tokens/cabeçalho de autorização e permissões no servidor. Não foi criado um token CSRF para um fluxo inexistente. XSS e roubo de token são tratados separadamente. |
| 11 | Upload sem validação | Nenhum fluxo de upload de usuário ou integração de Storage foi identificado no código examinado. Logo é um arquivo estático. Se uploads forem adicionados, exigirão validação de tamanho, formato/conteúdo e políticas de Storage; não foi declarada segurança de buckets não examinados. |
| 12 | Revelação de informações | Preparadas mensagens de erro genéricas, sem apresentar detalhes de SQL/Auth ao visitante. Não há `console.log` de tokens ou senhas no código da aplicação. Advertências e listas de destinatários/leitura deixam de aparecer nas projeções públicas. |
| 13 | Dependências vulneráveis | SDK Supabase fixado em `2.117.3`, empacotado localmente, com lockfile. `npm audit` final: zero vulnerabilidades conhecidas nas dependências npm. Isso não cobre a infraestrutura PostgreSQL nem garante ausência de falhas desconhecidas; fontes/CSS externos permanecem e estão restritos pela CSP. |
| 14 | Tokens | Preparados tokens aleatórios de 256 bits, hash SHA-256 no banco, expiração renovável de sete dias e absoluta de trinta dias, limite de vinte sessões ativas por jogador e logout com revogação. Sessões antigas serão invalidadas na implantação. Tokens do navegador ficam em `sessionStorage`, ainda acessível a JavaScript da mesma origem. |
| 15 | Rate limit | Preparados limites persistentes detalhados abaixo e limpeza de contadores inativos. Não há limitador por IP na borda nem proteção completa contra ataque distribuído; o orçamento global pode causar indisponibilidade se for esgotado. |
| 16 | Dados sensíveis expostos | Preparada redução de campos e de IDs públicos; tabelas de sessões e associação administrativa não são legíveis pelo visitante. Comunicados continuam acessíveis a quem saiba o ID. Não foi efetuada uma auditoria de todos os conteúdos enviados, logs, backups, e-mails ou recursos fora da aplicação. |
| 17 | SSRF | Não foi identificado backend que busque URLs fornecidas por usuários, Edge Function de fetch ou proxy. Conexões do navegador têm destinos delimitados. A CSP é uma restrição do navegador, não uma defesa contra SSRF em um servidor futuro. |
| 18 | Cookies inseguros | A aplicação não cria cookies de autenticação. Não se aplicam flags `HttpOnly`, `Secure` e `SameSite` aos tokens em `sessionStorage`. HTTPS já estava ativo. Se autenticação migrar para cookies, essas flags e defesa CSRF deverão ser implementadas. |
| 19 | CORS | O HTML público retornava `Access-Control-Allow-Origin: *`; isso isoladamente não expõe dados privados de uma página estática. Preparada restrição no site ao domínio informado, métodos GET/HEAD e sem credenciais. O CORS do serviço Supabase é separado: autorização no banco continua indispensável, pois clientes fora do navegador não obedecem CORS. |

As chaves públicas e seu uso esperado são descritos na [documentação oficial de chaves do Supabase](https://supabase.com/docs/guides/getting-started/api-keys). O bloqueio de acesso depende das [políticas RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Limites e ciclo das sessões preparados

| Operação | Limite preparado | Unidade |
|---|---|---|
| Entrada de jogadores | 600 tentativas/minuto | Endpoint inteiro |
| Entrada de um ID cadastrado | 5/minuto e 30/hora | Hash do ID; janela fixa |
| Atualização da sessão | 120/minuto | Hash do token válido |
| Consulta de comunicados | 120/minuto | Jogador |
| Confirmação de leitura | 60/minuto | Jogador |
| Escritas administrativas | Orçamento 5.000/minuto | Administrador; funções e linhas escritas consomem o orçamento |
| Importação de resultados | Até 100 participantes | Uma chamada administrativa |
| Sessões ativas de jogadores | Até 20 | Um jogador |

Os limites não são garantia de capacidade do banco. IDs inexistentes não criam contadores individuais; tentativas são contabilizadas no orçamento global. Contadores sem atividade há mais de dois dias são removidos em pequenos lotes durante operações. O limite administrativo conta múltiplas etapas de uma mesma operação, portanto não corresponde a 5.000 cliques ou chamadas independentes.

O frontend renova a consulta enquanto a página está ativa, limpa dados de acesso privilegiado quando há perda de autorização e encerra o painel após quinze minutos sem interação. O banco recusa administradores com sessão revogada, vencida ou criada há oito horas ou mais. A expiração por inatividade do painel é uma conveniência do cliente; a barreira no servidor é o limite de oito horas e a existência da sessão.

As mensagens do jogador são limitadas às 500 mais recentes. Leituras públicas/administrativas são paginadas em blocos de 200, com limite de 20.000 registros por atualização no frontend. Históricos que ultrapassem esses limites exigirão paginação de interface adicional.

## Melhorias fora da lista inicial

- Agrupamento de partidas passou a usar pares de número/data serializados, evitando colisões com sublinhados e nomes especiais de objetos JavaScript.
- Filtro de ID compara o valor completo e mantém todos os participantes da partida correspondente. Um visitante sem sessão não consegue pesquisar IDs completos ocultados pela projeção pública.
- A exclusão diferencia data nula da string literal `sem_data`, evitando excluir grupos diferentes juntos.
- Pontuação e prêmios são atualizados em transação ao adicionar, editar ou excluir resultados; novas duplicatas do mesmo jogador no mesmo grupo são rejeitadas.
- Banimento pela tela altera o status em vez de apagar o cadastro e seu histórico. Tokens de jogadores banidos são rejeitados.
- Posição pessoal no ranking usa identificador específico, evitando confusão quando dois jogadores compartilham nick e os mesmos quatro primeiros dígitos do ID. Jogador sem kills não recebe posição no ranking de kills.
- O selo “online” só aparece depois de leituras bem-sucedidas. Falhas de gravação não atualizam o estado local como se a operação tivesse funcionado; edição/exclusão verificam a quantidade de registros afetados.
- Notificações usam texto seguro; botões transportam dados em atributos escapados em vez de compor chamadas JavaScript com entradas do banco.
- MFA cadastra ou solicita o autenticador do administrador; tentativas de configuração incompletas são removidas antes de novo cadastro de fator. O QR é exibido como imagem, sem inserir seu SVG como HTML executável.
- Modais têm rótulos, foco, navegação por Tab e Escape. Campos recebem associação de rótulo; navegação tem suporte a teclado, zoom não fica bloqueado e animações respeitam preferência de movimento reduzido.
- Link de suporte fictício foi removido. Um endereço oficial opcional pode ser configurado; sem ele, o site orienta procurar a organização.
- Código, estilos e SDK foram separados do HTML. O processo de build limpa a pasta de saída validada e copia somente os sete recursos públicos; migrações, testes, dependências e arquivos locais não entram no pacote publicado.
- Foram preparados índices para consulta de partidas/comunicados e uma trilha privada de auditoria com ator, entidade, operação e horário, sem duplicar conteúdo de comunicados. Essa trilha também registra confirmações de leitura, com ator de Auth nulo para jogadores.

## Evidências e testes

Leituras do banco examinaram esquema, políticas, concessões, assinaturas e definições de funções e advisors. Havia 91 jogadores e 116 registros de resultados na leitura inicial. Não foram encontrados valores incompatíveis com as novas constraints nos levantamentos de jogadores/partidas e na consulta final de cupons/mensagens. Foi identificado **um grupo histórico com resultado duplicado para o mesmo jogador**; nenhuma linha ambígua foi apagada. A migração previne novas duplicatas e preserva a existente para revisão da organização.

O site remoto já retornava HTTPS/HSTS. Os cabeçalhos observados não incluíam CSP, `X-Frame-Options`, `X-Content-Type-Options` ou `Referrer-Policy`. Os novos cabeçalhos foram verificados como configuração local; não estão presentes por causa desta entrega no domínio público.

Resultados finais:

| Verificação | Resultado |
|---|---|
| `npm test` | 30 verificações aprovadas, zero falhas |
| Migrações PostgreSQL | Todas aplicadas em uma transação em banco isolado PGlite com `pgcrypto` |
| Autorizações | Leitura de tabelas protegidas bloqueada para `anon`; IDOR de comunicados negada; membro administrativo sem MFA não escreve; sessão revogada/banimento revogam acesso |
| Integridade de resultados | Inserção, edição e exclusão atualizam acumulados; repetição e negativos são rejeitados; datas nulas permanecem distintas |
| Frontend | Validação, XSS em toast/cupom, bloqueio de envios, atualização do painel e posição com IDs ocultados coincidentes |
| `npm run build` | Aprovado; saída contém sete arquivos públicos |
| `npm run package:security` | Aprovado; pacote SQL gerado das seis migrações |
| `npm audit` | Zero vulnerabilidades conhecidas, incluindo dependências de desenvolvimento |
| `git diff --check` | Aprovado |

Os testes SQL usam dados fictícios e PostgreSQL executado localmente. As funções de claims e as tabelas mínimas de Auth são fixtures; não representam um teste completo do serviço Supabase Auth. O frontend é testado em DOM simulado. Não foi concluído teste visual em navegador, pois o navegador integrado não alcançou o servidor local. Login real do administrador com autenticador, entrega de e-mails, recuperação de conta e cabeçalhos após publicação ainda precisam de verificação. Não houve teste de carga, ataque distribuído, scanner integral de infraestrutura ou invasão de contas reais.

## Pendências que impedem declarar produção corrigida

1. **Aplicar as migrações e publicar o novo build.** Renovar acesso das conexões ou seguir o procedimento manual. A implantação invalida sessões antigas; jogadores informarão o ID novamente.
2. **Configurar e verificar Auth do administrador.** Ativar proteção contra senhas vazadas quando disponível no plano, definir política de senha, conferir limites de login e CAPTCHA no provedor. Recuperação de MFA precisa de procedimento da organização; nenhum fator de conta real foi removido. Ver [segurança de senhas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection), [limites de Auth](https://supabase.com/docs/guides/auth/rate-limits) e [MFA TOTP](https://supabase.com/docs/guides/auth/auth-mfa/totp).
3. **Atualizar a infraestrutura PostgreSQL.** O projeto informa versão `17.6.1.166`; o Supabase anunciou a atualização 17.11 com correções de segurança. Deve-se conferir elegibilidade, backup e requisitos de extensões antes da atualização; ela não foi executada. [Aviso oficial da atualização](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes).
4. **Conferir configuração do projeto.** Verificar que `nova_private` não está entre os esquemas expostos na Data API; conferir URLs de redirecionamento, cadastro público de contas administrativas e acesso das integrações. O usuário comum de Auth nunca deve receber linha em `admin_users` automaticamente.
5. **Revisar a duplicata histórica.** Confirmar com a organização qual resultado é válido antes de recalcular totais ou remover registros. A entrega não escolhe arbitrariamente entre duas linhas reais.
6. **Validar o site implantado.** Testar ranking, login por ID, mensagens próprias/globais, marcação de leitura, entrada administrativa com MFA, operações administrativas e nova tentativa sem MFA. Conferir os cabeçalhos HTTP efetivos e executar os advisors novamente.
7. **Operação contínua.** Conferir backups/restauração, acesso mínimo de administradores e retenção da trilha de auditoria. A tabela de auditoria não possui limpeza automática; a organização deverá definir retenção e limpeza por uma operação privilegiada. Proteção por IP na borda e monitoramento de abuso permanecem pendentes.

A CSP preparada ainda permite estilos inline para manter a interface existente e usa Google Fonts/CSS do Font Awesome. JavaScript executável é limitado à própria origem. Remover esses fornecedores e todos os estilos inline seria uma melhoria adicional de independência e restrição, não uma mudança já realizada.

## Arquivos entregues

- `app.js`, `styles.css`, `index.html` e `public-config.js`: frontend corrigido, com login por ID preservado.
- `src/vendor.js`, `assets/supabase.js`, `package.json` e `package-lock.json`: SDK local e dependências fixadas.
- `supabase/migrations/20261010204621_security_hardening_01.sql` até `20261010204631_security_hardening_06.sql`: mudanças de banco, permissões e funções.
- `security/apply-security.sql`: pacote transacional gerado para aplicação manual.
- `vercel.json`: build e cabeçalhos de proteção preparados.
- `tests/security.test.cjs`, `tests/database.test.cjs` e `tests/legacy-schema.sql`: testes e esquema fictício; este último nunca deve ser aplicado em produção.
- `README.md`: implantação, validação e limitações operacionais.

O trabalho fecha as correções possíveis no código examinado e deixa explícitos o acesso por ID aceito pelo usuário e os passos de infraestrutura/publicação que ainda não foram executados.
