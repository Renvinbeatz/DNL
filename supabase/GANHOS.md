# Aba Ganhos do painel administrativo

Anúncios e inscrições pagas de não participantes são registrados por lançamentos que ficam salvos e se somam ao histórico.

| Campo | Cálculo |
|---|---|
| Total acumulado | (Participações registradas + inscrições pagas de não participantes) × R$ 6,00 |
| Repassado em premiação | Soma de jogadores.earnings, a mesma usada no cartão Premiações do painel |
| Gasto com anúncios | Soma de todos os lançamentos de anúncios |
| Não participantes pagos | Soma das quantidades lançadas manualmente |
| Inscrições dos não participantes | Quantidade acumulada de não participantes × R$ 6,00 |
| Saldo final | Acumulado − premiações − anúncios |

## Registrar valores

**Anúncios:** informar apenas o novo gasto. Um lançamento de R$ 80,00 seguido de outro de R$ 120,00 deixa o total em R$ 200,00. O campo é esvaziado depois de confirmar o salvamento. Não é mais necessário calcular nem substituir o total manualmente.

**Não participantes:** informar somente novas inscrições pagas de quem não jogou e não aparece nos resultados. Um lote de 3 seguido de outro de 2 deixa a quantidade em 5 e acrescenta R$ 30,00 ao acumulado. O valor se refere a inscrições ao longo dos diários, não a pessoas únicas. Esses lançamentos não criam jogadores, partidas, kills ou premiações e não entram no ranking.

Ambos os formulários permitem uma descrição opcional de até 160 caracteres, como a data do diário ou a campanha. Cada lançamento permanece no banco com data e autor administrativo. O histórico da aba mostra os 50 mais recentes; os totais consideram todos, inclusive os mais antigos.

Exemplo: duas participações nos resultados e cinco inscrições pagas de não participantes geram R$ 42,00 de receita. Se as premiações somarem R$ 10,00 e os anúncios R$ 20,00, o saldo será R$ 12,00.

Um cadastro sem partidas e sem lançamento de inscrição paga de não participante não gera receita. Jogadores bloqueados continuam contribuindo com o histórico anterior. Todos os cálculos abrangem o histórico completo, sem filtro de mês. O sistema calcula pelos registros, sem consultar extratos ou comprovantes de pagamento. A duplicata histórica identificada na auditoria continua exigindo revisão da organização, pois registros repetidos também afetam os totais.

Anúncios devem ser maiores que zero, com até duas casas decimais e limite de R$ 1.000.000.000,00 por lançamento. Não participantes devem ser uma quantidade inteira entre 1 e 1.000.000 por lote. O saldo pode ser negativo.

## Salvamento e atualização

Os lançamentos ficam no Supabase e são compartilhados entre administradores e dispositivos. Fechar ou recarregar o site não apaga o histórico. O botão de envio fica bloqueado durante a gravação. Se a resposta de um envio se perder, a repetição do mesmo formulário usa o mesmo identificador e não duplica o lançamento. Um novo envio confirmado é um lançamento adicional; descrições semelhantes não são usadas para deduplicar despesas legítimas.

Os totais são consultados ao abrir Ganhos, pelo botão Atualizar e após as atualizações do histórico, incluindo o ciclo existente de até 60 segundos enquanto o site estiver visível. Consultas não apagam o que está sendo digitado. Lançamentos de administradores diferentes se somam no banco, sem substituir os totais uns dos outros.

## Aplicação manual

Nenhuma publicação nem escrita remota foi feita nesta alteração. Confirmar o projeto aqvyehkrbjttvdirtjzd e um backup recuperável. As proteções 01–07, com as verificações de administrador e sessão no esquema nova_private, precisam existir.

Executar `npm run package:finances` para gerar os dois pacotes. Escolher **somente um**:

- **A aba Ganhos já foi ativada no banco:** aplicar uma vez `supabase/update-finance-entries.sql`. É somente a atualização `20261026094537_finance_entries.sql`. O total de anúncios já salvo vira um lançamento inicial chamado “Total de anúncios anterior à atualização”; nenhum resultado ou jogador é alterado.
- **A aba Ganhos ainda não foi ativada:** aplicar uma vez `supabase/enable-admin-finances.sql`. Ele inclui a instalação original e a atualização dos lançamentos, em uma transação.

Em seguida, publicar o frontend com `npm run build` e saída dist, incluindo index.html, app.js e styles.css. Fazer a atualização sem registrar gastos durante a troca e recarregar as abas antigas depois. O endpoint anterior de substituição do gasto perde a permissão de uso; o frontend novo usa a função de lançamentos.

Não executar os dois pacotes nem reaplicar o pacote completo de segurança para ativar esta funcionalidade. Se o projeto usa o CLI, aplicar as migrações financeiras em ordem pelo fluxo habitual, reconciliando o histórico caso tenham sido aplicadas manualmente.

Depois da publicação, conferir o total anterior e a persistência dos novos lançamentos. Todos são aditivos; digitar novamente o total já existente cria uma despesa adicional.

## Permissões e testes

Os registros ficam em nova_private.finance_entries, com RLS e sem acesso direto dos clientes. As funções expostas são SECURITY INVOKER; a implementação privada verifica administrador e sessão válida, usa search_path vazio e permissões explícitas. As inclusões também geram metadados na trilha privada de auditoria.

O frontend descarta respostas de sessões antigas e limpa os dados ao sair. Descrições são exibidas como texto, impedindo execução de HTML. Nenhum dado dos lançamentos é incluído nas consultas públicas de jogadores ou salvo no localStorage.

Verificações: `npm test`, `npm run build` e `npm run package:finances`. Testes em banco descartável e interface isolada cobrem soma, preservação do gasto anterior, idempotência, centavos, saldo, não interferência no ranking, histórico, validação, controle de acesso e revogação de sessão. Os testes da migração financeira original são mantidos separadamente para verificar o caminho de atualização.
