# Aba Ganhos do painel administrativo

A aba mostra o histórico completo da liga com a regra confirmada de **R$ 6,00 por jogador em cada partida registrada**.

| Campo | Cálculo |
|---|---|
| Total acumulado | Soma das participações (`jogadores.matchesCount`) × R$ 6,00 |
| Repassado em premiação | Soma de `jogadores.earnings`, a mesma usada no cartão Premiações do painel |
| Gasto com anúncios | Valor total informado e salvo pelo administrador |
| Saldo final | Acumulado − premiações − anúncios |

Um jogador apenas cadastrado, sem partidas, não gera receita. Um jogador bloqueado continua contribuindo com seu histórico. São considerados todos os registros existentes, sem filtro de mês ou data. O sistema calcula pelos resultados cadastrados; não consulta extratos ou comprovantes de pagamento.

A duplicata histórica indicada na auditoria de segurança continua exigindo revisão pela organização: registros contabilizados em duplicidade também afetam a receita calculada. Esta funcionalidade não remove nem altera resultados anteriores.

O gasto com anúncios começa em zero e fica salvo no Supabase, compartilhado entre os administradores e dispositivos. Informar `50,00` substitui o total anterior por R$ 50,00; não acrescenta R$ 50,00 a ele. O saldo pode ser negativo. O sistema aceita valores de anúncios entre R$ 0,00 e R$ 1.000.000.000,00, com até duas casas decimais.

Os totais são calculados no banco. A aba consulta os valores ao abrir e depois das atualizações do histórico, incluindo o ciclo existente de até 60 segundos enquanto o site estiver visível. O botão Atualizar permite uma nova consulta. Atualizar a página preserva o valor já salvo; atualizar os dados enquanto se digita um gasto não apaga o rascunho.

Se dois administradores alterarem o gasto ao mesmo tempo, o banco recusa a versão antiga, carrega o valor atualizado e pede que o administrador confira antes de salvar novamente. Uma falha ao carregar mostra os valores como indisponíveis, sem inventar saldo zero e sem interromper as outras áreas do painel.

## Instalação manual

Esta alteração foi preparada localmente. Nenhuma escrita remota ou publicação foi feita.

1. Confirmar o projeto Supabase `aqvyehkrbjttvdirtjzd` e um backup recuperável. As proteções anteriores 01–07, incluindo as funções de sessão/administração no esquema `nova_private`, precisam existir. O banco conferido nesta conversa já as possui.
2. Gerar o SQL com `npm run package:finances` e executar **uma única vez** `supabase/enable-admin-finances.sql` no SQL Editor com a conta responsável pelo banco. Ele envolve a migração `20261026090612_admin_finances.sql` em uma transação. Não reaplicar o pacote completo de segurança para ativar esta aba.
3. Publicar o frontend atualizado usando `npm run build` e saída `dist`, incluindo `index.html`, `app.js` e `styles.css`. A migração pode ser aplicada antes da publicação: não muda o funcionamento do frontend anterior.
4. Entrar como administrador, abrir Ganhos, conferir o acumulado e a premiação, salvar o total de anúncios e recarregar a página para confirmar a persistência.

Como alternativa ao SQL manual, aplicar a migração pelo fluxo habitual do Supabase CLI. Usar somente um dos caminhos e reconciliar o histórico se a organização alternar entre eles.

A migração de ganhos é separada da migração de segurança 08, também preparada nesta conversa. Uma não substitui a outra. O arquivo `security/apply-security.sql` continua sendo o pacote das oito migrações de segurança; ele não inclui esta funcionalidade. Aplicar a nova migração de ganhos depois das migrações anteriores ao usar o fluxo completo do CLI.

## Controle de acesso e verificação

O registro de anúncios fica em `nova_private.finance_settings`, com RLS habilitada e sem acesso direto de visitantes ou contas autenticadas. Somente as funções com conferência de administrador e sessão válida podem ler ou alterar os dados financeiros. As funções expostas são `SECURITY INVOKER`; as implementações privilegiadas ficam no esquema privado, com `search_path` vazio e permissões explícitas. As alterações ficam registradas na trilha privada de auditoria, sem conteúdo adicional de jogadores.

O frontend descarta respostas financeiras de sessões antigas e limpa os totais e o formulário ao sair. Nenhum valor financeiro é salvo no `localStorage` ou incluído nas consultas públicas de jogadores.

Verificações locais: `npm test`, `npm run build` e `npm run package:finances`. Os testes usam registros fictícios e cobrem fórmulas, centavos, saldo negativo, persistência, edição/exclusão de partidas, conflitos, validação e recusa de visitantes, contas comuns e sessões revogadas.
