# Estornos, relatórios e histórico administrativo — 30/10/2026

## Estorno

Na aba Ganhos, cada lançamento ativo possui o botão ESTORNAR. Informar um motivo de 3 a 300 caracteres. O original permanece visível, com o motivo e a identificação do estorno; o banco também guarda data e administrador.

Estornar anúncios retira aquela despesa e aumenta o saldo. Estornar não participantes retira a quantidade e sua receita de R$ 6 por inscrição. Premiações, jogadores e ranking não são modificados. Para corrigir um valor, estornar o incorreto e adicionar o lançamento certo. Repetir o pedido de estorno não desconta duas vezes nem substitui o motivo original.

## Exportação

Em Ganhos, escolher Lançamentos financeiros ou Resultados das partidas e baixar CSV, compatível com Excel, LibreOffice e importação no Google Sheets. São arquivos separados. Datas opcionais filtram pela **data de registro**, incluindo o dia final completo no fuso America/Sao_Paulo; não usam o texto livre de data da partida. Sem datas, exporta todo o histórico disponível. Acima de 20.000 registros, escolher um período menor: não há corte silencioso.

O financeiro inclui registros originais e estornados, autor, descrição e motivo. As colunas Despesa válida e Receita válida ficam zeradas para os estornados e podem ser somadas sem contar seus efeitos. A receita desse relatório corresponde às inscrições manuais de não participantes; a receita das participações registradas aparece na coluna Inscrição do relatório de resultados. Não é um extrato bancário nem um relatório de lucro mensal. Dados excluídos das partidas deixam de constar no relatório atual; a operação de exclusão permanece na auditoria.

O CSV usa ponto e vírgula, centavos com vírgula, cabeçalhos e codificação UTF-8. Campos de texto que poderiam ser interpretados como fórmulas recebem proteção antes do download.

## Histórico

A nova aba Histórico mostra administrador (e-mail disponível ou UUID), data, operação, entidade e registro afetado. As novas alterações nas tabelas de jogadores, resultados, cupons e comunicados também registram os nomes dos campos afetados e um rótulo do registro. Não são gravados conteúdos de comunicados ou senhas.

Os registros existentes são preservados e podem ter somente os metadados antigos; detalhes anteriores não podem ser reconstruídos. A lista carrega 50 por vez, com Carregar mais, usando cursor por identificador para evitar duplicação na paginação. É uma auditoria de operações no banco; ações internas/jogadores também podem aparecer identificadas como tal. Não registra visitas ou cliques sem gravação.

## Aplicação manual

As três funções foram preparadas e testadas localmente, sem publicação ou escrita remota. Gerar os pacotes com `npm run package:finances`, conferir backup e escolher **um** caminho conforme as migrações já aplicadas:

- Aba Ganhos com lançamentos acumulativos já instalada: aplicar somente `supabase/update-admin-reports.sql`.
- Somente a primeira versão da aba Ganhos, sem lançamentos: aplicar `supabase/update-finance-entries.sql`, que agora contém a atualização dos lançamentos e estas três funções.
- Primeira instalação de Ganhos: aplicar `supabase/enable-admin-finances.sql`, que reúne as três migrações e depende das proteções 01–07.

Não executar os três pacotes juntos nem reaplicar o pacote completo em banco já migrado. O novo arquivo de migração é `20261030054216_admin_reports_reversals.sql`. Aplicar uma vez, como responsável pelo banco, e publicar o frontend atualizado com `npm run build`, saída `dist`. Se usar o CLI, reconciliar primeiro o histórico de aplicações manuais.

Os novos endpoints só permitem administradores com sessão válida. As implementações privilegiadas ficam privadas e as funções públicas usam SECURITY INVOKER. Após publicar, conferir estorno, exportação e histórico com dados de teste controlados.
