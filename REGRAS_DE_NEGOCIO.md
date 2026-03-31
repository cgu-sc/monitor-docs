# Regras de Negócio - Monitor de Compras SC

## Documento de Especificação Técnica
**Versão:** 2.0.9  
**Data:** Março/2026  
**Projeto:** Monitor de Compras - CGU/SC

---

## 1. Visão Geral

O Monitor de Compras é um painel de Business Intelligence que consolida informações sobre compras públicas das UASGs de Santa Catarina jurisdicionadas à CGU. Este documento detalha todas as regras de negócio implementadas nas views SQL que alimentam o painel.

---

## 2. Fontes de Dados

### 2.1 Hierarquia de Prioridade

As licitações podem existir em múltiplas bases. A ordem de prioridade é:

| Prioridade | Fonte | Schema/Tabela | Período | Modalidades |
|------------|-------|---------------|---------|-------------|
| 1ª | **ComprasGov FaseExterna** | `db_compras.ComprasGov_FaseExterna.compra` | 2024+ | Todas |
| 2ª | **Comprasnet** | `db_compras.comprasnet.tb_compras` | Qualquer | Pregão, RDC |
| 3ª | **Siasg DW** | `db_dwsiasg.dbo.D_CMPR_COMPRA` | Até abril/2024 | Todas |
| 4ª | **PNCP** | `db_pncp.dbo.compra` | 2022+ | Dispensa, Inexigibilidade |

**Regras:**
- Se uma licitação existe no FaseExterna, os dados das outras fontes são ignorados para essa licitação.
- Se uma licitação existe no Comprasnet (mas não no FaseExterna), os dados do Siasg são usados apenas para complementar (situação e valores homologados).
- Licitações que existem APENAS no Siasg (não estão no FaseExterna nem no Comprasnet) são incluídas como terceira fonte.
- **Dispensas e Inexigibilidades do PNCP** que não existem em nenhuma das outras 3 fontes são incluídas como quarta fonte.

**Importante sobre o FaseExterna e modalidades:**
- O FaseExterna **possui Dispensas** (modalidade 6)
- O FaseExterna **NÃO possui Inexigibilidades** (modalidade 7)

**Importante sobre o PNCP:**
O PNCP (Portal Nacional de Contratações Públicas) é a **única fonte atualizada** para Dispensas e Inexigibilidades, já que:
- O FaseExterna não possui essas modalidades
- O Comprasnet possui dados incompletos
- O Siasg DW parou de ser atualizado em abril/2024

**Importante sobre o Siasg DW:**
O Siasg DW parou de ser atualizado em abril/2024. Por esse motivo:
- **NÃO usamos situações de suspensão** (código 119 e eventos relacionados 93-100), pois são estados temporários e a licitação pode ter sido retomada após a parada do DW.
- Usamos apenas **situações permanentes**: Revogada, Anulada, Cancelada, Homologada.

### 2.1.1 Hierarquia de Prioridade - ITENS (diferente de Licitações)

A hierarquia de prioridade para **itens** é diferente da hierarquia para **licitações**, porque a riqueza dos dados varia conforme a fonte. O Siasg DW é prioridade 2ª para itens (em vez do Comprasnet) por ter classificação completa e dados do fornecedor vencedor.

Ordem: **FaseExterna → Siasg DW → PNCP → Comprasnet**

> **→ Ver detalhes completos no §19 — Regras de Negócio de Itens** (hierarquia, anti-joins, campos disponíveis por fonte, classificação, lances, performance).

### 2.2 Bases Utilizadas

| Base | Tipo de Acesso | Conteúdo |
|------|----------------|----------|
| `db_alice_consulta` | Sigilosa | Licitações, pregões, UASGs, alertas Alice |
| `db_compras` | Restrita | Tabelas do Comprasnet (valores não sigilosos) |
| `db_compras_sigiloso` | Sigilosa | Tabelas do Comprasnet (valores sigilosos) |
| `db_compras.ComprasGov_FaseExterna` | Restrita | Nova estrutura do ComprasGov |
| `db_dwsiasg` | Restrita | Data Warehouse do Siasg (parou em abril/2024) |
| `db_pncp` | Restrita | Portal Nacional de Contratações Públicas |
| `db_portal` | Restrita | Portal da Transparência |
| `temp_CGUSC` | Trabalho | Views de apoio do projeto |

---

## 3. Identificador Único de Licitação (Cod_licitacao)

### 3.1 Estrutura

O `Cod_licitacao` é um identificador de **17 dígitos** que concatena:

```
[UASG - 6 dígitos] + [Modalidade - 2 dígitos] + [Número + Ano - 9 dígitos]
```

### 3.2 Exemplos

| UASG | Modalidade | Número | Ano | Cod_licitacao |
|------|------------|--------|-----|---------------|
| 30111 | 5 (Pregão) | 50 | 2022 | `03011105000502022` |
| 155913 | 6 (Dispensa) | 12 | 2024 | `15591306000122024` |

### 3.3 Construção por Fonte

**FaseExterna:**
```sql
CONCAT(
    RIGHT(REPLICATE('0', 6) + CAST(numero_uasg AS VARCHAR), 6),
    RIGHT(REPLICATE('0', 2) + CAST(codigo_modalidade AS VARCHAR), 2),
    RIGHT(REPLICATE('0', 5) + CAST(numero_compra AS VARCHAR), 5),
    RIGHT(CAST(ano_compra AS VARCHAR), 4)
)
```

**Comprasnet:**
```sql
CONCAT(
    RIGHT(REPLICATE('0', 6) + CAST(coduasg AS VARCHAR), 6),
    RIGHT(REPLICATE('0', 2) + CAST(modprp AS VARCHAR), 2),
    RIGHT(REPLICATE('0', 9) + CAST(numprp AS VARCHAR), 9)
)
```

**Siasg:**
```sql
CONCAT(
    RIGHT(REPLICATE('0', 6) + CAST(uasg.CD_UNDD_UNIDADE AS VARCHAR), 6),
    RIGHT(REPLICATE('0', 2) + CAST(MC.ID_CMPR_MODALIDADE_GRUPO AS VARCHAR), 2),
    SUBSTRING(CAST(C.DS_CMPR_COMPRA AS VARCHAR), LEN(C.DS_CMPR_COMPRA) - 8, 9)
)
```

> **Nota:** No comprasnet, o campo `numprp` já concatena número + ano (ex: `502022`).

---

## 4. Cálculo de Valores Estimados

### 4.1 Regra Principal: Característica/SRP

O cálculo do valor estimado depende da fonte de dados e de se a compra é **SRP (Sistema de Registro de Preços)** ou **Normal**.

#### FaseExterna — `valor_estimado` é SEMPRE unitário

> **⚠️ Correção v2.8:** Verificação empírica (março/2026) confirmou que o campo `item.valor_estimado` no FaseExterna é **sempre o valor unitário**, independente de a compra ser Normal (`caracteristica='1'`) ou SRP (`caracteristica='2'`). A regra anterior (v2.0–v2.7) tratava Normal como valor global — estava incorreta e resultava em valores subestimados para licitações Normais com `quantidade_solicitada > 1`.

| Tipo | Cálculo |
|------|---------|
| Normal ou SRP | `quantidade_solicitada × valor_estimado` (sempre) |

#### Comprasnet — `ipgValorRef` depende de SRP:
| Valor | Tipo | Cálculo |
|-------|------|---------|
| `N` | Normal | `ipgValorRef` (direto — já é valor global) |
| `S` | SRP | `quantidade × ipgValorRef` |

### 4.2 Fórmulas SQL para Cálculo do Valor Estimado por Item

As fórmulas abaixo calculam o **valor estimado total de cada item**:

**FaseExterna:**
```sql
-- valor_estimado é SEMPRE unitário no FaseExterna (confirmado em março/2026)
COALESCE(quantidade_solicitada, 1) * COALESCE(valor_estimado, 0) AS valor_estimado_calculado
```

**Comprasnet:**
```sql
-- Calcula valor_estimado_item (valor total estimado do item)
CASE 
    WHEN srp = 'S' THEN 
        -- SRP: ipgValorRef é unitário, precisa multiplicar pela quantidade
        COALESCE(quantidade, 1) * COALESCE(ipgValorRef, 0)
    ELSE -- srp = 'N'
        -- Normal: ipgValorRef já é o valor total do item
        COALESCE(ipgValorRef, 0)
END
```

> **Resumo:** O valor estimado **total da licitação** é a soma dos valores estimados de todos os itens calculados conforme acima.
> 
> **Diferença entre fontes:** No FaseExterna, `valor_estimado` é sempre unitário. No Comprasnet, `ipgValorRef` é unitário para SRP e global para Normal. No Siasg DW, há campos separados para unitário e global.

**Siasg DW:**
```sql
-- No Siasg DW, o campo VL_ITCP_PRECO_GLOBAL_ESTIM já contém o valor TOTAL estimado do item
-- (já multiplicado pela quantidade quando aplicável). Não é necessário cálculo adicional.
COALESCE(f_item.VL_ITCP_PRECO_GLOBAL_ESTIM, 0) AS valor_estimado_calculado
-- Também disponível: VL_ITCP_PRECO_UNIT_ESTIM (valor unitário)
```

### 4.3 Valor Estimado Sigiloso

Mesmo cálculo, mas apenas para itens com:
- FaseExterna: `orcamento_sigiloso = 'S'`
- Comprasnet: `valorSigiloso = 1`
- Siasg DW: `D_ITCP_IN_VL_SIGILOSO.ID_ITCP_IN_VL_SIGILOSO = 1`

---

## 5. Cálculo de Valores Adjudicados

### 5.1 Regra para FaseExterna

O valor adjudicado só é calculado para itens que atendem **TODAS** as condições:

| Condição | Campo | Valor |
|----------|-------|-------|
| Item ativo | `item.situacao` | `= '1'` |
| Proposta adjudicada | `proposta_item.situacao` | `= '6'` |

> **⚠️ Correção v2.9 — Campo `item.homologado` removido das condições:**
> 
> Nas versões anteriores (v2.0–v2.8), o campo `item.homologado = 'S'` era exigido como condição adicional. Análise empírica de março/2026 revelou que **35% das licitações homologadas** (159.943 de 456.276) tinham propostas adjudicadas (`proposta_item.situacao = '6'`) mas com `item.homologado = 'N'`. Ou seja, 1 em cada 3 licitações homologadas ficava **sem valor adjudicado** no painel.
>
> **Conclusão:** O campo `item.homologado` **não é confiável** para determinar se o item foi adjudicado. A homologação é registrada no nível da **compra** (`compra.homologada = 'S'`), mas o campo a nível de **item** frequentemente não é atualizado. A existência de proposta com `situacao = '6'` (Adjudicada) é a condição suficiente e confiável.
>
> O campo `item.homologado` continua sendo trazido na view como informação (`item_homologado`), mas **não é mais usado como filtro** para cálculo de valores adjudicados.

#### Situações do Item (FaseExterna):
| Código | Descrição | Conta para Adjudicado? |
|--------|-----------|------------------------|
| 1 | Ativo | ✅ Sim (se tem proposta adjudicada) |
| 2 | Cancelado | ❌ Não |
| 3 | Anulado | ❌ Não |
| 4 | Revogado | ❌ Não |
| 5 | Suspenso | ❌ Não |
| 6 | Deserto | ❌ Não |
| 7 | Fracassado na análise | ❌ Não |
| 8 | Fracassado no julgamento | ❌ Não |
| 9 | Fracassado na disputa | ❌ Não |

#### Situações da Proposta (FaseExterna):
| Código | Descrição | Considera? |
|--------|-----------|------------|
| 1 | Proposta desclassificada na análise | ❌ Não |
| 2 | Proposta desclassificada no julgamento | ❌ Não |
| 3 | Proposta aceita | ❌ Não |
| 4 | Fornecedor habilitado | ❌ Não |
| 5 | Fornecedor inabilitado | ❌ Não |
| **6** | **Proposta adjudicada** | ✅ **Sim** |
| 7 | Pendente aceite para assumir cota | ❌ Não |
| 8 | Recusa para assumir cota | ❌ Não |
| 9 | Proposta desclassificada na sala de disputa | ❌ Não |

### 5.2 Fórmula de Cálculo (FaseExterna)

Conforme orientação do SERPRO. **Valores são sempre unitários no FaseExterna** (v2.8: multiplicar por quantidade em todos os casos):

```sql
CASE 
    WHEN item.situacao = '1' AND proposta.situacao = '6' THEN
        -- Sempre multiplicar quantidade × valor unitário
        COALESCE(qtde_adjudicada, quantidade_ofertada, quantidade_solicitada, 1)
        * COALESCE(
            valor_negociado_julgamento_calculado,
            valor_lance_calculado,
            melhor_valor_proposta_lance_calculado,
            valor_proposta_calculado
        )
    ELSE NULL
END
```

#### Hierarquia de Valores:
1. `valor_negociado_julgamento_calculado` (prioridade máxima — pós-negociação)
2. `valor_lance_calculado` (pós-disputa)
3. `melhor_valor_proposta_lance_calculado` (melhor valor do item)
4. `valor_proposta_calculado` (proposta inicial — fallback para Concorrências fechadas, v2.9)

> **Por que `valor_proposta_calculado` é o último?** Ele é o valor **inicial** da proposta, antes de lances e negociação. Num Pregão, os 3 primeiros campos sempre têm valor, então nunca chega no 4º. Numa Concorrência com modo "Fechado", não há lances nem negociação — os 3 primeiros são NULL e o `valor_proposta_calculado` é o único disponível.

#### Hierarquia de Quantidades:
1. `item.qtde_adjudicada` (prioridade)
2. `proposta.quantidade_ofertada`
3. `item.quantidade_solicitada` (fallback adicionado v2.8)

### 5.3 Regra para Comprasnet - Limitação da Versão CGU

A versão do Comprasnet disponível na CGU (`db_compras`) **não possui** as tabelas de propostas com valores adjudicados. No Comprasnet original do SERPRO existe a tabela `DBO.TBL_PROPOSTAITEM` com campos como:

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `ippIndAceito` | varchar(1) | Indicador de proposta aceita: NULL=Não avaliada, A=Aceita, R=Recusada |
| `ippIndHabilitado` | char(1) | Indicador de habilitação: NULL=Não avaliada, H=Habilitada, I=Inabilitada |
| `ippIndAdjudicado` | char(1) | Indicador de adjudicação: NULL=Não avaliada, S=Adjudicada, N=Recusada |
| `ippValorClassif` | money | Valor da proposta para classificação |
| `ippValNegAceit` | money | Valor negociado na aceitação |
| `ippValNegAdj` | money | Valor negociado na adjudicação |

**Porém, essa tabela não está disponível no `db_compras` da CGU.**

Por isso, para licitações do Comprasnet, o valor adjudicado/homologado é obtido do **Siasg DW**:

```sql
valor_homologado_siasg -- Campo VL_PRECO_TOTAL_HOMOLOG da view vw_valor_homologado_siasg_sc
```

> **Limitações:**
> - O Siasg DW parou de ser atualizado em abril/2024
> - Para licitações mais recentes do Comprasnet, não há valor homologado disponível
> - Por isso a importância de usar o FaseExterna para compras de 2024 em diante

### 5.4 Regra para Siasg DW - Itens com Fornecedor

O valor adjudicado e os dados do fornecedor vencedor no Siasg DW são obtidos via `F_ITEM_FORNECEDOR` + `D_FRND_FORNECEDOR`, com filtro `VL_PRECO_TOTAL_HOMOLOG > 0` para identificar vencedores.

> **→ Ver detalhes completos no §19.3** — Fornecedor vencedor e valores adjudicados por fonte.

---

## 6. Situação da Licitação

### 6.1 Dois Campos de Situação

| Campo | Propósito | Fonte |
|-------|-----------|-------|
| `Situacao_Fonte` | Situação oficial cadastrada na base | Direta da fonte de dados |
| `Situacao_Gerada` | Situação calculada para regras de negócio | Lógica combinada |

### 6.2 Situação Fonte - FaseExterna

Campo `compra.situacao_compra`:

| Código | Descrição |
|--------|-----------|
| PD | Publicada/Divulgada |
| RE | Revogada |
| AN | Anulada |
| SU | Suspensa |
| FR | Fracassada |
| DE | Deserta |

> **Importante:** `PD` (Publicada/Divulgada) pode significar tanto "em andamento" quanto "homologada". Por isso, é necessário verificar o campo `compra.homologada` separadamente.

### 6.3 Situação Fonte - Comprasnet (via Siasg)

Campo `D_CMPR_SIT_ATUAL_COMPRA.ID_CMPR_SIT_ATUAL_COMPRA`:

| Códigos | Situação |
|---------|----------|
| 88, 91, 118 | Revogada |
| 40, 43, 111 | Anulada |

Campo `tbl_pregao.prgStatus` (apenas para pregões - modalidade 5):

| Código | Descrição |
|--------|-----------|
| 0 | Fechado |
| 1 | Aberto |
| 2 | Homologado |
| 3 | Suspenso |
| 4 | Deserto |

### 6.4 Situação Gerada - Lógica Completa

#### Para FaseExterna:
```sql
CASE 
    WHEN situacao_compra = 'RE' THEN 'Revogada'
    WHEN situacao_compra = 'AN' THEN 'Anulada'
    WHEN situacao_compra = 'SU' THEN 'Suspensa'
    WHEN situacao_compra = 'FR' THEN 'Fracassada'
    WHEN situacao_compra = 'DE' THEN 'Deserta'
    WHEN homologada = 'S' THEN 'Homologada'
    ELSE 'Não Homologada'
END
```

#### Para Comprasnet (múltiplas fontes):
```sql
CASE 
    -- Revogação (Siasg - estados finais)
    WHEN id_situacao_compra IN (88, 91, 118) THEN 'Revogada'
    -- Anulação (Siasg - estados finais)
    WHEN id_situacao_compra IN (40, 43, 111) THEN 'Anulada'
    -- Deserta (pregão)
    WHEN situacao_pregao = 4 THEN 'Deserta'
    -- Homologada pelo Comprasnet
    WHEN situacao_pregao = 2 THEN 'Homologada'
    -- Outros eventos de Revogação (Siasg)
    WHEN id_situacao_compra IN (85, 86, 87, 89, 90, 92) THEN 'Revogada'
    -- Outros eventos de Anulação (Siasg)
    WHEN id_situacao_compra IN (37, 38, 39, 41, 42, 44) THEN 'Anulada'
    -- Evento de cancelamento no Siasg
    WHEN id_situacao_compra = 105 THEN 'Cancelada'
    -- Valor homologado no Siasg sem evento de anulação ou revogação
    WHEN valor_homologado_siasg IS NOT NULL THEN 'Homologada'
    -- Senão
    ELSE 'Não Homologada'
END
```

#### Para Siasg (quando usado como terceira fonte):
```sql
CASE 
    -- Revogação (estados finais)
    WHEN id_situacao_compra IN (88, 91, 118) THEN 'Revogada'
    -- Anulação (estados finais)
    WHEN id_situacao_compra IN (40, 43, 111) THEN 'Anulada'
    -- Outros eventos de Revogação
    WHEN id_situacao_compra IN (85, 86, 87, 89, 90, 92) THEN 'Revogada'
    -- Outros eventos de Anulação
    WHEN id_situacao_compra IN (37, 38, 39, 41, 42, 44) THEN 'Anulada'
    -- Evento de cancelamento
    WHEN id_situacao_compra = 105 THEN 'Cancelada'
    -- Valor homologado no Siasg sem evento de anulação ou revogação
    WHEN valor_adjudicado_total > 0 THEN 'Homologada'
    -- Senão
    ELSE 'Não Homologada'
END
```

> **IMPORTANTE - Por que NÃO usamos suspensão no Siasg:**
> O Siasg DW parou de ser atualizado em abril/2024. Situações de suspensão (código 119 e eventos 93-100) são **estados temporários** - uma licitação suspensa pode ter sido retomada e finalizada após a parada do DW. Usar esses estados poderia resultar em informação incorreta, mostrando como "suspensa" uma licitação que na verdade já foi concluída. Por segurança, usamos apenas situações permanentes.

### 6.5 Valores Possíveis de Situacao_Gerada

| Situação | Descrição | Censura Sigilo? |
|----------|-----------|-----------------|
| Homologada | Licitação concluída com sucesso | ❌ Não |
| Revogada | Licitação revogada | ❌ Não |
| Anulada | Licitação anulada | ❌ Não |
| Cancelada | Licitação cancelada (apenas Siasg) | ❌ Não |
| Suspensa | Licitação suspensa (apenas FaseExterna) | ❌ Não |
| Fracassada | Licitação fracassada (apenas FaseExterna) | ❌ Não |
| Deserta | Licitação deserta | ❌ Não |
| **Não Homologada** | **Em andamento** | ✅ **Sim** |

---

## 7. Regras de Censura de Sigilo

### 7.1 Regra Principal

**Censurar valores sigilosos APENAS quando:** `Situacao_Gerada = 'Não Homologada'`

**Mostrar valores sigilosos em TODAS as outras situações**, pois a licitação já "terminou" de alguma forma e o sigilo não tem mais propósito.

### 7.2 Campos Afetados pela Censura

| Campo | Quando Censurar | O que Mostrar |
|-------|-----------------|---------------|
| `valor_estimado_total` | Se Não Homologada E possui itens sigilosos | Faixa de valor |
| `valor_estimado_sigiloso` | Se Não Homologada | 0 ou Faixa de valor |
| Estimativas por fonte (Alice, Comprasnet, Siasg) | Se Não Homologada E possui itens sigilosos | Faixa de valor |

### 7.3 Faixas de Valor para Censura

Quando censurar, mostrar intervalos ao invés do valor exato:

| Condição | Texto Exibido |
|----------|---------------|
| Valor = 0 ou NULL | `0,00` |
| 0 < Valor ≤ 150.000 | `Até 150 mil` |
| 150.000 < Valor ≤ 1.000.000 | `De 150 mil a 1 milhão` |
| 1.000.000 < Valor ≤ 2.000.000 | `De 1 a 2 milhões` |
| 2.000.000 < Valor ≤ 5.000.000 | `De 2 a 5 milhões` |
| 5.000.000 < Valor ≤ 10.000.000 | `De 5 a 10 milhões` |
| Valor > 10.000.000 | `Acima de 10 milhões` |

### 7.4 Implementação SQL (Exemplo)

```sql
CASE 
    WHEN qtd_itens_sigilosos > 0 AND Situacao_Gerada = 'Não Homologada' THEN
        CASE 
            WHEN valor_estimado_total IS NULL OR valor_estimado_total = 0 
                THEN FORMAT(0, 'N', 'pt-BR')
            WHEN valor_estimado_total > 0 AND valor_estimado_total <= 150000 
                THEN 'Até 150 mil'
            WHEN valor_estimado_total > 150000 AND valor_estimado_total <= 1000000 
                THEN 'De 150 mil a 1 milhão'
            -- ... demais faixas
            ELSE 'Acima de 10 milhões'
        END
    ELSE FORMAT(valor_estimado_total, 'N', 'pt-BR')
END AS 'Valor Estimado'
```

---

## 8. Versionamento de Registros

### 8.1 FaseExterna

Tanto `compra` quanto `item` possuem campo `versao`. Sempre usar a **versão mais recente**, com `id DESC` como desempate (itens podem ser recriados com mesmo `versao` — ver §14.1.1):

```sql
ROW_NUMBER() OVER (
    PARTITION BY numero_uasg, codigo_modalidade, numero_compra, ano_compra 
    ORDER BY versao DESC, id DESC
) AS rn
-- Filtrar: WHERE rn = 1
```

### 8.2 Comprasnet

As tabelas `tb_compras_mat` e `tb_compras_serv` possuem histórico por `dataAlteracao`. Sempre usar a **data mais recente**:

```sql
ROW_NUMBER() OVER (
    PARTITION BY coduasg, modprp, numprp, codGrupo, item 
    ORDER BY dataAlteracao DESC
) AS rn
-- Filtrar: WHERE rn = 1
```

---

## 9. União de Dados Sigilosos

### 9.1 Comprasnet - Bases Separadas

No Comprasnet, os valores estimados de itens sigilosos ficam **zerados** no `db_compras` enquanto a compra não está homologada. Os valores reais estão em base separada (`db_compras_sigiloso`). A regra para obter todos os itens é:

1. Trazer itens de `db_compras` **apenas se `ipgValorRef <> 0`** (evita trazer itens com valor zerado por sigilo)
2. Trazer **todos** os itens de `db_compras_sigiloso` (que contém os valores sigilosos reais)
3. Fazer `UNION ALL`
4. Selecionar versão mais recente por `dataAlteracao`

```sql
-- Itens com valor preenchido (não sigilosos ou já homologados)
SELECT * FROM db_compras.comprasnet.tb_compras_mat 
WHERE ISNULL(ipgValorRef, 0) <> 0

UNION ALL

-- Itens sigilosos (valores reais que estavam zerados no db_compras)
SELECT * FROM db_compras_sigiloso.comprasnet.tb_compras_mat
```

> **Importante:** O acesso ao `db_compras_sigiloso` requer assinatura de Termo de Sigilo em razão de Acordo de Cooperação Técnica firmado entre o Ministério da Economia e a CGU.

> **Importante 2:** Verificar periodicamente se a regra permanece a mesma de zerar os itens sigilosos do `db_compras` e incluí-los unicamente no `db_compras_sigiloso`, pois caso venham a ser replicados, tornaria nossa listagem errada. 

### 9.2 FaseExterna - Base Única

No FaseExterna, os valores sigilosos **sempre aparecem no mesmo banco** (`db_compras.ComprasGov_FaseExterna`), independente da situação da compra. Não há necessidade de consultar bases separadas.

O campo `item.orcamento_sigiloso = 'S'` apenas **indica** que o item teve orçamento sigiloso, mas o valor está disponível normalmente no campo `valor_estimado` (também recomenda-se verificar esta regra periodicamente, visto que a CGPLA às vezes altera sem aviso prévio).

```sql
-- Todos os itens (sigilosos e não sigilosos) estão na mesma tabela
SELECT * FROM db_compras.ComprasGov_FaseExterna.item
-- O campo orcamento_sigiloso indica se foi sigiloso, mas o valor está preenchido
```

> **Resumo da diferença:**
> - **Comprasnet:** Valores sigilosos em banco separado (`db_compras_sigiloso`)
> - **FaseExterna:** Valores sigilosos no mesmo banco (`db_compras`)

---

## 10. Filtros de Jurisdição

### 10.1 UASGs Jurisdicionadas

A view `vw_jurisdicionadas_sc` define as UASGs de Santa Catarina jurisdicionadas à CGU:

- Cruza com `vw_orgaos_jurisdicionados_cgu` (tabela copiada para `temp_CGUSC`)
- Cruza com Portal da Transparência para obter UG correta
- Filtra por `UF = 'SC'`

### 10.2 Filtro Temporal

Todas as views de licitações filtram por `ano_compra >= 2022` para:
- Melhor performance
- Foco em dados recentes
- Consistência com o escopo do projeto

---

## 11. Alertas Alice

### 11.1 Estrutura

Os alertas podem estar vinculados a:
- `licitacao_id` (diretamente)
- `pregao_id` (indiretamente, quando `licitacao_id` é NULL)

Usar `COALESCE(licitacao_id, pregao.licitacao_id)` para obter o vínculo correto.

### 11.2 Integração com e-CGU

A tabela `eaud_integracao` indica se o alerta gerou tarefa no e-CGU (e-Aud).

---

## 12. Modalidades de Licitação

### 12.1 Códigos Consolidados (Todas as Fontes)

| Código | Descrição | Fontes |
|--------|-----------|--------|
| 1 | Convite | FaseExterna, Comprasnet, Siasg |
| 2 | Tomada de Preços | FaseExterna, Comprasnet, Siasg |
| 3 | Concorrência | FaseExterna, Comprasnet, Siasg |
| 4 | Concorrência Internacional | Comprasnet, Siasg |
| 5 | Pregão | FaseExterna, Comprasnet, Siasg |
| 6 | Dispensa | FaseExterna, Comprasnet, Siasg |
| 7 | Inexigibilidade | FaseExterna, Comprasnet, Siasg |
| 20 | Concurso | FaseExterna, Comprasnet, Siasg |
| 22 | Tomada de Preços (variante) | Comprasnet |
| 33 | Concorrência (variante) | Comprasnet |
| 44 | Concorrência Internacional (variante) | Comprasnet |
| 99 | RDC (Regime Diferenciado de Contratações) | Comprasnet |

### 12.2 Códigos por Fonte - FaseExterna

| Código | Descrição |
|--------|-----------|
| 1 | Convite |
| 2 | Tomada de Preços |
| 3 | Concorrência |
| 5 | Pregão |
| 6 | Dispensa |
| 7 | Inexigibilidade |
| 20 | Concurso |

### 12.3 Códigos por Fonte - Comprasnet

| Código | Descrição |
|--------|-----------|
| 1 | Convite |
| 2 | Tomada de Preços |
| 3 | Concorrência |
| 4 | Concorrência Internacional |
| 5 | Pregão |
| 6 | Dispensa |
| 7 | Inexigibilidade |
| 20 | Concurso |
| 22 | Tomada de Preços (variante) |
| 33 | Concorrência (variante) |
| 44 | Concorrência Internacional (variante) |
| 99 | RDC (Regime Diferenciado de Contratações) |

> **Nota:** O `prgStatus` da `tbl_pregao` só é válido para modalidade 5 (Pregão).

### 12.4 Códigos por Fonte - Siasg

| Código | Descrição |
|--------|-----------|
| 1 | Convite |
| 2 | Tomada de Preços |
| 3 | Concorrência |
| 4 | Concorrência Internacional |
| 5 | Pregão |
| 6 | Dispensa |
| 7 | Inexigibilidade |
| 20 | Concurso |

---

## 13. Resumo das Views

| View | Propósito | Fonte Principal |
|------|-----------|-----------------|
| `vw_jurisdicionadas_sc` | Filtro de UASGs de SC | db_alice_consulta, db_portal |
| `vw_licitacoes_faseexterna_sc` | Licitações do FaseExterna | ComprasGov_FaseExterna |
| `vw_licitacoes_comprasnet_sc` | Licitações do Comprasnet | comprasnet |
| `vw_licitacoes_siasg_sc` | Licitações do Siasg (terceira fonte) | db_dwsiasg |
| `vw_disp_inex_pncp_sc` | **Apenas** Dispensas/Inexigibilidades do PNCP (quarta fonte) | db_pncp |
| `vw_licitacoes_consolidada_sc` | **View principal** - União priorizada (4 fontes) | FaseExterna → Comprasnet → Siasg → PNCP |
| `vw_siasg_situacao_sc` | Situação e valores do Siasg (auxiliar) | db_dwsiasg |
| `vw_itens_faseexterna_sc` | Itens do FaseExterna | ComprasGov_FaseExterna |
| `vw_itens_siasg_sc` | **Itens do Siasg DW (segunda fonte de itens)** | db_dwsiasg |
| `vw_itens_comprasnet_sc` | Itens do Comprasnet | comprasnet |
| `vw_itens_consolidada_sc` | **View principal de itens** (4 fontes) | FaseExterna → Siasg → PNCP → Comprasnet |
| `sp_itens_licitacoes_pbi` | **Stored Procedure para Power BI** - itens com censura de sigilo | vw_itens_consolidada_sc + vw_licitacoes_consolidada_sc |
| `vw_alertas_alice_sc` | Alertas do Alice | db_alice_consulta |
| `vw_alice_eaud_integracao_sc` | Integração Alice/e-CGU | db_alice_consulta |

### 13.1 Campos Principais das Views de Licitações

| Campo | Descrição | Tipo |
|-------|-----------|------|
| `Cod_licitacao` | Identificador único de 17 dígitos | VARCHAR(17) |
| `UASG` | Código da UASG | INT |
| `Modalidade` | Código da modalidade | INT |
| `Nome_Modalidade` | Descrição da modalidade | VARCHAR |
| `numero_compra` | Número da compra | INT |
| `ano_compra` | Ano da compra | INT |
| `numprp` | Número + ano concatenados | INT |
| `data_primeira_publicacao` | **Data da primeira publicação** (Alice ou fallback) | DATETIME |
| `data_ultima_publicacao` | **Data da última publicação** (Alice ou fallback) | DATETIME |
| `data_publicacao_fonte` | Origem das datas: 'ALICE', 'FASEEXTERNA', 'COMPRASNET', 'SIASG' ou 'PNCP' | VARCHAR |
| `Situacao_Gerada` | Situação calculada para regras de censura | VARCHAR |
| `valor_estimado_total` | Valor estimado total calculado | DECIMAL |
| `valor_estimado_sigiloso` | Valor estimado de itens sigilosos | DECIMAL |
| `valor_adjudicado_total` | Valor adjudicado/homologado | DECIMAL |
| `fonte_dados` | 'FASEEXTERNA', 'COMPRASNET', 'SIASG' ou 'PNCP' | VARCHAR |

> **Nota:** Os campos da jurisdicionadas (tipo_adm, poder, esfera, UASG_UG, Nome_UG) **não são trazidos nas views de licitações**. O relacionamento é feito no Power BI via coluna UASG.

### 13.2 Compatibilidade de Tipos no UNION

Para que o UNION ALL funcione entre FaseExterna e Comprasnet, é necessário que os campos tenham tipos compatíveis. Na view de itens Comprasnet, campos inexistentes são definidos com CAST explícito:

```sql
-- Exemplo de campos com CAST para NULL tipado
CAST(NULL AS DATETIME) AS data_hora_inclusao,
CAST(NULL AS DECIMAL(18,2)) AS valor_adjudicado_calculado,
CAST(NULL AS VARCHAR(200)) AS nome_fornecedor,
CAST(NULL AS INT) AS qtde_propostas_melhor_valor
```

**Importante:** Usar `NULL` sem CAST pode causar erro de incompatibilidade de tipos (ex: `int é incompatível com datetime2`).

---

## 14. Observações Importantes sobre as Bases

### 14.1 Registros Duplicados no FaseExterna

Foi identificado que cada licitação no esquema `ComprasGov_FaseExterna` possui **6 registros idênticos** na tabela `compra`. Todos os campos são iguais, incluindo o campo `versao`. 

Isso significa que:
- O FaseExterna **NÃO guarda histórico de versões** das licitações
- O campo `versao` contém apenas o número da versão atual (última), não há registros das versões anteriores
- A `data_hora_inclusao` é a mesma para todos os registros duplicados

**Impacto:** Não é possível obter a data da primeira publicação diretamente do FaseExterna. Para contornar, utilizamos JOIN com o Alice para obter essa informação.

**Recomendação:** Sempre usar `SELECT DISTINCT` ou `ROW_NUMBER()` ao consultar a tabela `compra` do FaseExterna para evitar multiplicação de registros.

#### Query de Verificação Periódica

Executar periodicamente para verificar se a base foi corrigida e passou a guardar versões diferentes:

```sql
-- Verifica se existe alguma licitação com registros diferentes (dataCargaCgu distinta)
-- Se retornar VAZIO: todos os registros continuam 100% idênticos (situação atual)
-- Se retornar RESULTADOS: a base passou a guardar versões, revisar as views
SELECT 
    numero_uasg,
    codigo_modalidade,
    numero_compra,
    ano_compra,
    COUNT(*) AS qtd_registros,
    COUNT(DISTINCT dataCargaCgu) AS qtd_datas_carga_distintas,
    MIN(dataCargaCgu) AS data_carga_min,
    MAX(dataCargaCgu) AS data_carga_max
FROM db_compras.ComprasGov_FaseExterna.compra
WHERE ano_compra >= 2022
GROUP BY numero_uasg, codigo_modalidade, numero_compra, ano_compra
HAVING COUNT(DISTINCT dataCargaCgu) > 1
ORDER BY qtd_datas_carga_distintas DESC;
```

**Última verificação:** Fevereiro/2026 - Resultado: vazio (todos os registros idênticos)

#### 14.1.1 Itens Recriados com Novos IDs (mesmo `numero_item`, mesma `versao`)

> **Problema descoberto em março/2026:** O FaseExterna pode recriar itens com **novos `id`** mantendo o mesmo `numero_item` e `versao = 0`. Isso acontece quando uma licitação passa por alterações significativas (ex: mudança de lei aplicável, reclassificação de itens). O resultado são múltiplos registros na tabela `item` com a mesma chave lógica `(numero_uasg, codigo_modalidade, numero_compra, ano_compra, numero_grupo, numero_item)` mas IDs físicos diferentes.
>
> **Exemplo real:** Pregão 90037/2025, UASG 155913 — item 1 tinha 3 IDs diferentes:
> | id | numero_item | versao | valor_estimado | qtd | tem proposta adj.? |
> |---|---|---|---|---|---|
> | 3622649 | 1 | 0 | 16,10 | 1640 | Sim |
> | 3890178 | 1 | 0 | 59.465,00 | 34 | Não |
> | 3905278 | 1 | 0 | 59.465,00 | 34 | **Sim** (R$ 5.500 negociado) |
>
> O `ROW_NUMBER() ... ORDER BY versao DESC` não desempata (todos têm versao=0), podendo selecionar um registro antigo/obsoleto que não tem proposta adjudicada.

**Correção v2.9:** Adicionar `id DESC` como critério de desempate em todos os `ROW_NUMBER`:

```sql
-- Itens:
ROW_NUMBER() OVER (
    PARTITION BY i.numero_uasg, i.codigo_modalidade, i.numero_compra, i.ano_compra, 
                 i.numero_grupo, i.numero_item 
    ORDER BY i.versao DESC, i.id DESC  -- id maior = registro mais recente
) AS rn

-- Compras:
ROW_NUMBER() OVER (
    PARTITION BY c.numero_uasg, c.codigo_modalidade, c.numero_compra, c.ano_compra 
    ORDER BY c.versao DESC, c.id DESC
) AS rn
```

**Aplicado em:** `vw_itens_faseexterna_sc` (CTEs `compras_recentes` e `itens_recentes`) e `vw_licitacoes_faseexterna_sc` (mesmas CTEs).

### 14.2 Datas de Publicação (Primeira e Última)

O projeto utiliza duas datas de publicação:
- **`data_primeira_publicacao`**: Data da primeira versão publicada da licitação
- **`data_ultima_publicacao`**: Data da versão mais recente publicada da licitação

A **data da primeira publicação** é utilizada para filtrar licitações a partir de 2022.

**Fontes das datas (em ordem de prioridade):**

| Data | Fonte Preferencial | Fallback |
|------|-------------------|----------|
| `data_primeira_publicacao` | Alice (`versao = 1`) → `data_publicacao` | `data_hora_inclusao` (FaseExterna) ou `datainclusao` (Comprasnet) ou `DT_CMPR_RESULTADO_COMPRA` (Siasg) |
| `data_ultima_publicacao` | Alice (versão mais recente) → `data_publicacao` | `data_hora_inclusao` (FaseExterna) ou `datainclusao` (Comprasnet) ou `DT_CMPR_RESULTADO_COMPRA` (Siasg) |

**Importante sobre o Siasg:** O campo `DT_PUBLICACAO_DOU` tem 88% de valores inválidos (1900-01-01) para Dispensas e Inexigibilidades. Por isso, o fallback usa `DT_CMPR_RESULTADO_COMPRA` que está 100% preenchido.

**Análise de qualidade das datas no Siasg (SC, 2022+):**

| Campo | Inválidas | Válidas | Total | % Inválidas |
|-------|-----------|---------|-------|-------------|
| DT_PUBLICACAO_DOU | 4.666 | 2.321 | 6.987 | **67%** |
| DT_REFERENCIA_COMPRA | 757 | 6.230 | 6.987 | 11% |
| DT_CMPR_RESULTADO_COMPRA | 0 | 6.987 | 6.987 | **0%** |

**DT_PUBLICACAO_DOU por modalidade:**

| Modalidade | Nome | Inválidas | Válidas | Total | % Inválidas |
|------------|------|-----------|---------|-------|-------------|
| 2 | Tomada de Preços | 0 | 16 | 16 | 0% |
| 3 | Concorrência | 0 | 7 | 7 | 0% |
| 5 | Pregão | 8 | 1.642 | 1.650 | **0,5%** |
| 6 | Dispensa | 2.695 | 426 | 3.121 | **86%** |
| 7 | Inexigibilidade | 1.963 | 229 | 2.192 | **90%** |
| 20 | Concurso | 0 | 1 | 1 | 0% |

> **Conclusão:** O problema de `DT_PUBLICACAO_DOU` é quase exclusivo de Dispensas e Inexigibilidades (86-90% inválidas). Para Pregões e outras modalidades, a data está OK (0-0,5% inválidas). Por isso, o fallback para `data_primeira_publicacao` usa `DT_CMPR_RESULTADO_COMPRA` que está 100% preenchido.

**Importante:** Os campos `data_hora_inclusao` (FaseExterna) e `datainclusao` (Comprasnet) **não mudam entre versões** - são sempre a data da primeira inclusão. Portanto, quando o fallback é usado, `data_primeira_publicacao` e `data_ultima_publicacao` terão o mesmo valor.

**Campos disponíveis nas views:**
- `data_primeira_publicacao` - Data da primeira publicação (Alice ou fallback)
- `data_ultima_publicacao` - Data da última publicação (Alice ou fallback)
- `data_publicacao_fonte` - Indica a origem de ambas as datas: 'ALICE', 'FASEEXTERNA', 'COMPRASNET' ou 'SIASG'

**Filtro temporal:**
```sql
WHERE YEAR(COALESCE(alice_primeira.data_primeira_publicacao_alice, data_inclusao_fallback)) >= 2022
```

**Observação:** O fallback para `data_hora_inclusao`/`datainclusao` pode ser significativamente diferente da data real de publicação em casos de licitações suspensas por longos períodos. O campo `data_publicacao_fonte` permite identificar esses casos.

### 14.3 Licitações que Existem no Comprasnet mas Não no Alice

Algumas licitações constam do Comprasnet, mas não do Alice. Isso pode ocorrer por diversos motivos (falhas de sincronização, licitações muito antigas, etc.). Para essas licitações, o filtro temporal é feito pelo `ano_compra`.

### 14.4 Ordenação por dataAlteracao no Comprasnet

Para garantir que sempre selecionamos a versão mais recente de um registro no Comprasnet, deve-se ordenar pelo campo `dataAlteracao` (data em que o registro foi alterado no sistema de origem).

**Motivo:** O campo `dataAlteracao` reflete quando o registro foi efetivamente modificado, sendo mais confiável para determinar qual é a versão mais atual.

**Implementação para tb_compras (licitações):**
```sql
ROW_NUMBER() OVER (
    PARTITION BY coduasg, modprp, numprp 
    ORDER BY dataAlteracao DESC
) AS rn_compra
-- Filtrar: WHERE rn_compra = 1
```

**Implementação para itens (tb_compras_mat/tb_compras_serv):**
```sql
ROW_NUMBER() OVER (
    PARTITION BY coduasg, modprp, numprp, codGrupo, item 
    ORDER BY dataAlteracao DESC
) AS rn
-- Filtrar: WHERE rn = 1
```

### 14.5 Licitações do FaseExterna sem Itens Carregados

> **Achado de março/2026:** Existem licitações registradas na tabela `compra` do FaseExterna (inclusive com `homologada = 'S'`) que **não possuem nenhum registro** na tabela `item`. Essas licitações aparecem no painel com valores estimados e adjudicados zerados.

**Escala do problema:**

| Métrica | Valor |
|---------|-------|
| Total de licitações no FaseExterna (2022+) | 520.080 |
| Licitações sem itens | 10.206 |
| Percentual | **~2%** |

**Impacto:**
- A `vw_licitacoes_faseexterna_sc` traz a licitação (dados da `compra`), mas a CTE `valores_agregados` retorna zeros porque não há itens para somar.
- A `vw_itens_consolidada_sc` faz anti-join a nível de **licitação** — se a licitação existe no FaseExterna, os itens do Comprasnet/Siasg são excluídos, mesmo que o FaseExterna não tenha itens.
- Verificação no Comprasnet para um caso específico (UASG 135030, Pregão 90011/2024) mostrou que os itens existem lá, porém **sem valores** (`ipgValorRef = NULL`). Ou seja, complementar com Comprasnet não resolveria o problema de valores.

**Causa provável:** Licitações onde os itens ainda não foram migrados/carregados no FaseExterna, ou licitações que foram registradas na `compra` mas cujos itens foram removidos ou nunca inseridos.

**Decisão:** Aceitar como limitação de dados das fontes (~2%). Não há correção aplicável no SQL — o dado simplesmente não existe. O campo `fonte_dados = 'FASEEXTERNA'` no painel permite identificar esses casos para investigação manual quando necessário.

**Possível melhoria futura:** Implementar anti-join a nível de **item** (não de licitação) na consolidada de itens, permitindo que itens do Comprasnet complementem licitações do FaseExterna que não têm itens. Porém, como os itens do Comprasnet frequentemente também não têm valores, o ganho seria limitado.

---

## 15. Mapeamento de Domínios entre Fontes

Esta seção documenta os valores possíveis para campos que precisam de normalização entre FaseExterna e Comprasnet.

### 15.1 Modo de Disputa

**FaseExterna** - Campo `compra.modo_disputa` (varchar 2):
| Código | Descrição |
|--------|-----------|
| `A` | Aberto |
| `F` | Fechado |
| `AF` | Aberto/Fechado |
| `FA` | Fechado/Aberto |

**Comprasnet** - Campo `tb_compras.prgModoDisputa` (varchar 2):
| Código | Descrição |
|--------|-----------|
| `NULL` | Sem modo disputa (Decreto 5450/2005) |
| `A` | Aberto |
| `AF` | Aberto/Fechado |

**Comprasnet** - Campo `tb_compras.modoDisputa` (tinyint) - Para Pregão:
| Código | Descrição |
|--------|-----------|
| `1` | Aberto |
| `3` | Aberto/Fechado |

**Comprasnet** - Campo `tb_compras.modoDisputa` (tinyint) - Para RDC:
| Código | Descrição |
|--------|-----------|
| `1` | Fechado/Aberto Sem Desclassificação |
| `2` | Fechado |
| `3` | Fechado/Aberto/Fechado |
| `4` | Fechado/Aberto |

> **Nota:** FaseExterna usa códigos de letras (A, F, AF, FA). Comprasnet usa códigos numéricos que **dependem da modalidade**: para Pregão (5) são 1 e 3; para RDC (99) são 1, 2, 3 e 4 com significados diferentes. O campo `prgModoDisputa` (varchar) é uma versão alternativa com códigos de letras.

### 15.2 Tipo de Objeto

**FaseExterna** - Campo `compra.tipo_objeto` (varchar 2):
| Código | Descrição |
|--------|-----------|
| `1` | Bens |
| `2` | Obras |
| `3` | Serviços |
| `4` | Serviços de engenharia |
| `5` | Bens comuns |
| `6` | Serviços comuns |
| `7` | Serviços comuns de engenharia |
| `8` | Bens especiais |
| `9` | Serviços especiais |
| `10` | Serviços especiais de engenharia |
| `11` | Obras Comuns |
| `12` | Obras Especiais |
| `13` | Trabalho Técnico, Científico ou Artístico |
| `14` | Bens e Serviços Especiais de TIC |
| `15` | Obras e Serviços Especiais de Engenharia |
| `16` | Objetos que admitam soluções específicas e alternativas |
| `17` | Serviços Técnicos especializados de natureza intelectual |
| `18` | Serviços majoritariamente dependentes de tecnologia sofisticada |
| `19` | Estudos técnicos, planejamentos, projetos básicos e executivos |
| `20` | Fiscalização, supervisão e gerenciamento de obras e serviços |
| `21` | Controles de qualidade e tecnológico, análises |

**Comprasnet** - Campo `tb_compras.tipoObjeto` (tinyint) - Nível de compra:
| Código | Descrição |
|--------|-----------|
| `1`  | Bens |
| `2`  | Obras |
| `3`  | Serviços |
| `4`  | Serviços de Engenharia |
| `5`  | Bens Comuns |
| `6`  | Serviços Comuns |
| `7`  | Serviços Comuns de Engenharia |
| `8`  | Bens Especiais |
| `9`  | Serviços Especiais |
| `10` | Serviços Especiais de Engenharia |
| `11` | Obras Comuns |
| `12` | Obras Especiais |

> **Nota:** Os códigos 1-12 são **compatíveis** entre FaseExterna e Comprasnet. FaseExterna possui valores adicionais (13-21) que não existem no Comprasnet.

**Comprasnet** - Campo `tb_compras_mat/serv.objetoItem` - Nível de item:
| Código | Descrição |
|--------|-----------|
| `0` | Sem Domínio |
| `1` ou `BC` | Bens Comuns |
| `2` ou `SC` | Serviços Comuns |
| `3` ou `SE` | Serviços Comuns de Engenharia |

> **Nota:** O campo `objetoItem` no nível de item tem menos valores que `tipoObjeto` no nível de compra.

### 15.3 Critério de Julgamento

**FaseExterna** - Campo `compra.criterio_julgamento` (varchar 1):
| Código | Descrição |
|--------|-----------|
| `3` | Melhor Técnica |
| `4` | Técnica e Preço |
| `5` | Conteúdo Artístico |
| `6` | Maior Retorno Econômico |
| `7` | Menor Preço / Maior Desconto |
| `8` | Melhor Técnica / Conteúdo Artístico |

**Comprasnet** - Campo `tb_compras.criterioJulgamento` (tinyint):
| Código | Descrição |
|--------|-----------|
| `1` | Menor Preço |
| `2` | Maior Desconto |
| `3` | Melhor Técnica |
| `4` | Técnica e Preço |
| `5` | Conteúdo Artístico |
| `6` | Maior Retorno Econômico |
| `7` | Menor Preço / Maior Desconto |

> **Nota:** Comprasnet tem códigos 1 e 2 (Menor Preço e Maior Desconto separados) que não existem no FaseExterna. FaseExterna tem código 8 (Melhor Técnica / Conteúdo Artístico) que não existe no Comprasnet. Os códigos 3-7 são compatíveis.

**Comprasnet** - Campo `tb_compras_mat/serv.criterioValor` (nível de item):
| Código | Descrição |
|--------|-----------|
| `0` | Sem domínio |
| `1` ou `M` | Valor máximo aceitável |
| `2` ou `E` | Valor estimado |
| `3` ou `R` | Valor de referência |

> **Atenção:** O campo `criterioValor` no nível de item é um conceito **diferente** de `criterioJulgamento` - indica o tipo de valor de referência, não o critério de julgamento da licitação.

### 15.4 Indicador de Sigilo

**FaseExterna** - Campo `item.orcamento_sigiloso` (varchar 1):
| Código | Descrição |
|--------|-----------|
| `S` | Sigiloso |
| `N` | Não sigiloso |

**Comprasnet** - Campo `tb_compras_mat/serv.valorSigiloso` (tinyint):
| Código | Descrição |
|--------|-----------|
| `0` | Sem domínio |
| `1` | Sim (Sigiloso) |
| `2` | Não |

**Comprasnet** - Campo `tb_compras_mat/serv.valorSigiloso` (char 1) - Versão alternativa:
| Código | Descrição |
|--------|-----------|
| `S` | Sigiloso |
| `N` | Não sigiloso |
| `NULL` | Informação não disponível (pregões antigos) |

### 15.5 Emergencial

**FaseExterna** - Campo `compra.emergencial` (varchar 1):
| Código | Descrição |
|--------|-----------|
| `S` | Sim (Emergencial) |
| `N` | Não |

**Comprasnet** - Campo `tb_compras.prgIndEmergencial` (char 1):
| Código | Descrição |
|--------|-----------|
| `S` | Sim (Emergencial) |
| `N` | Não |

> **Nota:** Este campo é compatível entre as fontes.

### 15.6 Característica (SRP)

**FaseExterna** - Campo `compra.caracteristica` (varchar 1):
| Código | Descrição |
|--------|-----------|
| `1` | Tradicional/SISPP (Normal) |
| `2` | Registro de Preço/SRP |

**Comprasnet** - Campo `tb_compras.srp` (char 1):
| Código | Descrição |
|--------|-----------|
| `N` | Não (Normal) |
| `S` | Sim (SRP) |

### 15.7 Regime de Execução

**FaseExterna** - Campo `compra.regime_execucao` (varchar 1):
| Código | Descrição |
|--------|-----------|
| `1` | Empreitada por Preço Global |
| `2` | Empreitada por Preço Unitário |
| `3` | Contratação por Tarefa |
| `4` | Empreitada Integral |
| `5` | Contratação Integrada/Semi-Integrada |
| `6` | Contratação Integrada |
| `7` | Contratação Semi-Integrada |
| `8` | Fornecimento e Prestação de Serviço Associado |

**Comprasnet** - Campo `tb_compras.regimeExecucao` (tinyint):
| Código | Descrição |
|--------|-----------|
| `1` | Empreitada por Preço Global |
| `2` | Empreitada por Preço Unitário |
| `3` | Contratação por Tarefa |
| `4` | Empreitada Integral |
| `5` | Contratação Integrada/Semi-Integrada |
| `6` | Contratação Integrada |
| `7` | Contratação Semi-Integrada |
| `8` | Fornecimento e Prestação de Serviço Associado |

> **Nota:** Os códigos são compatíveis entre FaseExterna e Comprasnet.

### 15.8 Fase da Compra (FaseExterna)

Campo `compra.fase_compra` (varchar 1):
| Código | Descrição |
|--------|-----------|
| `1` | Aguardando abertura da sessão pública |
| `2` | Em análise de propostas |
| `3` | Disputa iniciada |
| `4` | Seleção de fornecedores iniciada |
| `5` | Carregando compra da Fase Interna |
| `6` | Aguardando publicação |

### 15.9 Eventos de Compra (Comprasnet)

Campo `tb_compras_evento.evento` (int):
| Código | Descrição |
|--------|-----------|
| `1` | Cancelamento Anulação/Revogação |
| `2` | Adiamento |
| `3` | Revogação |
| `4` | Anulação |
| `5` | Alteração |
| `6` | Retificação |
| `7` | Suspensão |
| `8` | Reabertura |

---


## 16. PNCP - Portal Nacional de Contratações Públicas

### 16.1 Visão Geral

O PNCP é a **quarta fonte de dados** do sistema, utilizada exclusivamente para capturar **Dispensas e Inexigibilidades** que não existem nas outras bases. É a única fonte atualizada para essas modalidades.

### 16.2 Mapeamento de Modalidades

| Código PNCP | Nome PNCP | Código Normalizado | Nome Normalizado |
|-------------|-----------|-------------------|------------------|
| 8 | Dispensa | 6 | Dispensa de Licitação |
| 9 | Inexigibilidade | 7 | Inexigibilidade de Licitação |

> **Nota:** Os códigos são diferentes entre PNCP e Comprasnet/Siasg. Na view consolidada, os códigos são normalizados para manter compatibilidade.

### 16.3 Tabelas de Domínio do PNCP

#### Situação da Compra (`situacaocompra`)
| ID | Nome | Mapeamento Situacao_Gerada |
|----|------|---------------------------|
| 1 | Em andamento | Não Homologada |
| 2 | Homologado | Homologada |
| 3 | Anulado/Revogado/Cancelado | Anulada |
| 4 | Deserto | Deserta |
| 5 | Fracassado | Fracassada |

#### Situação do Item (`situacaocompraitem`)
| ID | Nome | Incluir no Valor Estimado? |
|----|------|---------------------------|
| 1 | Em andamento | ✅ Sim |
| 2 | Homologado | ✅ Sim |
| 3 | Anulado/Revogado/Cancelado | ❌ Não |
| 4 | Deserto | ✅ Sim |
| 5 | Fracassado | ✅ Sim |

#### Situação do Resultado do Item (`situacaocompraitemresultado`)
| ID | Nome | Incluir no Valor Adjudicado? |
|----|------|------------------------------|
| 1 | Informado | ✅ Sim |
| 2 | Cancelado | ❌ Não |

#### Modo de Disputa (`mododisputa`)
| ID | Nome |
|----|------|
| 1 | Aberto |
| 2 | Fechado |
| 3 | Aberto-Fechado |
| 4 | Dispensa Com Disputa |
| 5 | Não se aplica |
| 6 | Fechado-Aberto |

#### Indicador de Orçamento Sigiloso (`indicadororcamentosigiloso`)
| ID | Nome | possui_sigilo |
|----|------|---------------|
| 1 | Não sigiloso | NÃO |
| 2 | Compra parcialmente sigilosa | SIM |
| 3 | Compra totalmente sigilosa | SIM |

### 16.4 Cálculo de Valores no PNCP

**Regra única:** Sempre usar `quantidade × valor_unitário`, independente de SRP.

```sql
-- Valor Estimado (de compraitem)
SUM(quantidade * valorunitarioestimado) 
WHERE situacaocompraitemid <> 3

-- Valor Adjudicado (de compraitemresultado)
SUM(quantidadehomologada * valorunitariohomologado) 
WHERE situacaocompraitemresultadoid <> 2
```

> **Observação:** O campo `valortotal` nos itens pode ter pequenas diferenças de arredondamento. Por isso, sempre calculamos `quantidade × valorunitarioestimado`.

### 16.5 Filtros Aplicados

| Filtro | Condição |
|--------|----------|
| Apenas ativos | `excluido = 'f'` |
| Apenas Dispensa/Inexigibilidade | `modalidadeid IN (8, 9)` |
| UASGs de SC | JOIN com `vw_jurisdicionadas_sc` via `unidadeorgao.codigounidade` |
| Período | `YEAR(datapublicacaopncp) >= 2022` |

### 16.6 ⚠️ Pontos de Atenção

**Campo `numerocompra` despadronizado:**
- O campo pode conter valores não numéricos, impossibilitando uso como chave de JOIN com outras bases.
- Exemplos de valores problemáticos: "060301/2024", "10 | Processo 212024", "25 | Processo 79", "DL 1".
- IDs de exemplo para consulta futura: `5843124`, `5843646`, `5848011`, `5870659`
- **Impacto:** O campo `numprp` pode ser NULL quando `numerocompra` não é numérico.
- **Mitigação:** Como usamos PNCP apenas para Dispensas e Inexigibilidades (que não existem nas outras bases), não há necessidade de JOIN por esse campo.

---

## 17. Regras de Negócio — Itens de Licitação

Esta seção centraliza todas as regras de negócio relacionadas aos **itens** das licitações. As regras de itens diferem das regras de licitações em hierarquia de prioridade, campos disponíveis, lógica de valores e performance de consulta.

### 17.1 Hierarquia de Prioridade de Itens

A hierarquia de prioridade para **itens** é diferente da hierarquia para **licitações**, porque a riqueza dos dados de item varia significativamente entre as fontes:

| Prioridade | Fonte | Classificação Material/Serviço | Fornecedor Vencedor | Valores Adjudicados | Qtd Lances | Qtd Fornecedores c/ Proposta |
|------------|-------|-------------------------------|---------------------|---------------------|------------|------------------------------|
| 1ª | **FaseExterna** | ✅ Completa (via `codigo_item_catalogo` → DW) | ✅ Sim (`proposta_item` + `participacao`) | ✅ Sim | ❌ Não disponível | ✅ `COUNT(proposta_item)` |
| 2ª | **Siasg DW** | ✅ Completa (`D_ITCP_MATERIAL_SERVICO`) | ✅ Sim (`F_ITEM_FORNECEDOR` + `D_FRND_FORNECEDOR` + dimensões) | ✅ Sim (`VL_PRECO_TOTAL_HOMOLOG` e `VL_PRECO_UNIT_HOMOLOG`) | ✅ `QT_ITCP_LANCES_ITEM` | ✅ `COUNT(F_ITEM_FORNECEDOR)` |
| 3ª | **PNCP** | ❌ Não disponível | ✅ Parcial (`compraitemresultado`) | ✅ Sim | ❌ | ❌ |
| 4ª | **Comprasnet** | ⚠️ Parcial (grupo + classe, sem material individual para serviços) | ❌ Não (`TBL_PROPOSTAITEM` indisponível na CGU) | ❌ Não | ❌ (futuro: `TBL_LANCES`) | ❌ (futuro: `TBL_PROPOSTAITEM`) |

**Justificativa da diferença em relação às licitações:**
- Para **licitações**, o Comprasnet é prioridade 2ª porque tem dados estruturais (situação, modalidade, datas) mais atualizados que o Siasg DW.
- Para **itens**, o Siasg DW é prioridade 2ª porque possui classificação completa de material/serviço e dados do fornecedor vencedor, que o Comprasnet da CGU não possui (falta da tabela `TBL_PROPOSTAITEM`).
- O Siasg DW parou de ser atualizado em abril/2024. Itens de licitações posteriores que não estejam no FaseExterna caem para PNCP (3ª) ou Comprasnet (4ª).

**Regras de anti-join para itens (consolidada):**
1. Se os itens da licitação existem no **FaseExterna** → usar FaseExterna
2. Se NÃO existem no FaseExterna, mas existem no **Siasg DW** → usar Siasg DW
3. Se NÃO existem no FaseExterna nem no Siasg DW, mas existem no **PNCP** → usar PNCP
4. Se NÃO existem em nenhuma das anteriores → usar **Comprasnet**

### 17.2 Campos Específicos de Itens — Decisões Técnicas

#### 17.2.1 Quantidade de Lances por Item (`qtd_lances_item`)

**Decisão:** Campo disponível **apenas para itens do Siasg DW**.

| Fonte | Campo | Disponibilidade |
|-------|-------|-----------------|
| Siasg DW | `F_ITEM_COMPRA.QT_ITCP_LANCES_ITEM` | ✅ Total de lances do item (todos os rounds de todos os fornecedores) |
| FaseExterna | — | ❌ **Não existe.** A tabela `proposta_item` armazena apenas o estado final de cada fornecedor (1 registro por fornecedor por item), sem histórico individual de lances. Não há tabela dedicada de lances no schema do FaseExterna. |
| Comprasnet | `TBL_LANCES` + `TBL_LANCES_ENCERRADOS` | ⏳ **Implementação futura.** É possível obter via `COUNT(*)` agrupado por `ipgCod`, fazendo `UNION ALL` de `TBL_LANCES` e `TBL_LANCES_ENCERRADOS` (lances movidos após homologação). Só se aplica a Pregões (modalidade 5). |
| PNCP | — | ❌ Não disponível |

**Análise do FaseExterna:** O máximo que se consegue extrair é `COUNT(proposta_item WHERE valor_lance_calculado IS NOT NULL)` por item, mas isso retorna o **número de fornecedores que deram pelo menos um lance** — semântica diferente de "total de lances". Por isso, optou-se por **não popular esse campo** no FaseExterna (`NULL`), evitando confusão de métricas.

Na consolidada e na SP, o campo é passado como `NULL` para FaseExterna, Comprasnet e PNCP.

#### 17.2.2 Número de Fornecedores com Proposta (`qtd_fornecedores_propostas`)

**Decisão:** Campo disponível para **FaseExterna** e **Siasg DW**.

| Fonte | Implementação | Observação |
|-------|---------------|------------|
| FaseExterna | `(SELECT COUNT(*) FROM proposta_item WHERE id_item = i.id)` | Conta todas as propostas (independente de terem lance ou não) |
| Siasg DW | `(SELECT COUNT(ID_ITFN_ITEM_FORNECEDOR) FROM F_ITEM_FORNECEDOR WHERE ID_CMPR_COMPRA = ... AND ID_ITCP_ITEM_COMPRA = ...)` | Conta todos os fornecedores que participaram do item |
| Comprasnet | `NULL` | `TBL_PROPOSTAITEM` não disponível no `db_compras` da CGU |
| PNCP | `NULL` | Não disponível |

**Nota sobre `qtde_propostas_melhor_valor`:** O campo `item.qtde_propostas_melhor_valor` do FaseExterna retorna `-1` na grande maioria dos casos (diagnóstico realizado em fev/2026), não sendo útil para esta finalidade.

#### 17.2.3 Campos Adicionais do Siasg DW (não disponíveis em outras fontes)

A `vw_itens_siasg_sc` traz campos que só existem no Siasg DW, correspondentes aos que já eram utilizados na consulta anterior (`vw_valor_homologado_siasg_sc`):

**Valores:**
| Campo | Origem | Observação |
|-------|--------|------------|
| `valor_estimado` | `F_ITEM_COMPRA.VL_ITCP_PRECO_UNIT_ESTIM` | Valor **unitário** estimado |
| `valor_estimado_calculado` | `F_ITEM_COMPRA.VL_ITCP_PRECO_GLOBAL_ESTIM` | Valor **global** (já multiplicado por quantidade) |
| `valor_unitario_homologado` | `F_ITEM_FORNECEDOR.VL_PRECO_UNIT_HOMOLOG` | Preço unitário homologado do vencedor |
| `valor_adjudicado_calculado` | `F_ITEM_FORNECEDOR.VL_PRECO_TOTAL_HOMOLOG` | Preço total homologado do vencedor |

> **Atenção no `valor_estimado`:** No FaseExterna, `valor_estimado` é **sempre unitário** (confirmado março/2026, ver §4.1). No Comprasnet, `ipgValorRef` é unitário para SRP e global para Normal. No Siasg DW, `VL_ITCP_PRECO_UNIT_ESTIM` é sempre unitário e `VL_ITCP_PRECO_GLOBAL_ESTIM` é sempre global.

**Dimensões indicadoras do item (via `D_ITCP_ITEM_COMPRA`):**
| Campo na view | Tabela DW | Descrição |
|---------------|-----------|-----------|
| `grupo_compra` | `D_ITCP_IN_COMPRA_GRUPO` | Se o item pertence a um grupo de compra |
| `criterio_julgamento_item` | `D_ITCP_TP_CRITERIO_JULG` | Critério de julgamento (menor preço, etc.) |
| `criterio_valor` | `D_ITCP_IN_CRITERIO_VALOR` | Critério de valor aplicado |
| `desempate_me` | `D_ITCP_IN_DESEMPATE_ME_EPP` | Indicador de desempate ME/EPP |
| `tipo_objeto_item` | `D_ITCP_IN_TIPO_OBJETO` | Tipo do objeto do item |
| `valor_sigiloso_descricao` | `D_ITCP_IN_VL_SIGILOSO` | Descrição do indicador de sigilo |
| `sit_atual_mat_serv` | `D_ITCP_SIT_ATUAL_MAT_SERV` | Situação atual do material/serviço no catálogo |
| `padrao_desc_mat` | `D_ITCP_PADRAO_DESC_MAT` | Padrão de descrição do material (PDM) |

**Outros campos:**
| Campo | Origem | Observação |
|-------|--------|------------|
| `numero_item` | `RIGHT(D_ITCP_ITEM_COMPRA.CH_ITCP_ITEM_COMPRA, 5)` | Últimos 5 dígitos da chave do item |
| `unidade_fornecimento` | `D_ITCP_ITEM_COMPRA.DS_ITCP_UNIDADE_FORNECIMENTO` | Unidade de fornecimento do item |
| `data_hora_homologacao` | `D_ITCP_ITEM_COMPRA.DT_ULT_HOMOLOGACAO` | Data da última homologação do item |
| `prazo_dias` | Calculado na SP: `DATEDIFF(day, data_primeira_publicacao, data_abertura)` | Prazo entre publicação e abertura (dias). Calculado na `sp_itens_licitacoes_pbi` usando datas da `vw_licitacoes_consolidada_sc`, cobrindo **todas** as fontes (não apenas Siasg). |
| `quantidade_solicitada` | `F_ITEM_COMPRA.QT_ITCP_SOLICITADA` | Quantidade solicitada |
| `quantidade_ofertada` | `F_ITEM_FORNECEDOR.QT_OFERTADA` | Quantidade ofertada pelo vencedor |

**JOIN de Material/Serviço — Correção v2.0:**

Na versão 1.0 da view, o JOIN de classificação usava `d_item.ID_ITCP_MATERIAL_SERVICO` (via dimensão do item). O correto, conforme a consulta original, é usar `f_item.ID_ITCP_TP_COD_MAT_SERV` (via tabela fato):

```sql
-- CORRETO (v2.0): via tabela fato
LEFT JOIN D_ITCP_MATERIAL_SERVICO AS mat_serv
    ON f_item.ID_ITCP_TP_COD_MAT_SERV = mat_serv.ID_ITCP_TP_COD_MAT_SERV

-- ERRADO (v1.0): via dimensão do item
-- LEFT JOIN D_ITCP_MATERIAL_SERVICO AS mat_serv
--     ON d_item.ID_ITCP_MATERIAL_SERVICO = mat_serv.ID_ITCP_MATERIAL_SERVICO
```

#### 17.2.4 Número do Grupo (`numero_grupo`)

O campo `numero_grupo` identifica o grupo ao qual o item pertence em licitações com itens agrupados.

| Fonte | Campo | Observação |
|-------|-------|------------|
| FaseExterna | `item.numero_grupo` | Direto da tabela — confiável |
| Comprasnet | `TB_COMPRAS_MAT.codGrupo` / `TB_COMPRAS_SERV.codGrupo` | Valores ≤ 0 são sentinelas (sem grupo) |
| Siasg DW | `NULL` | O DW não tem conceito de grupo de itens |
| PNCP | `NULL` | Não disponível |

**Correção v2.8 — Comprasnet:** Valores sentinela do `codGrupo` (0, -1, -2, -3) eram exibidos como números de grupo válidos. Corrigido para tratar ≤ 0 como NULL:

```sql
-- ANTES (v2.7): trazia sentinelas como grupo válido
ti.codGrupo AS numero_grupo

-- AGORA (v2.8): sentinelas viram NULL
CASE WHEN ti.codGrupo > 0 THEN ti.codGrupo ELSE NULL END AS numero_grupo
```

> **Nota:** O campo `tipo_item` (I=Item, S=Subitem de grupo) também depende de `codGrupo > 0` e já estava correto.

#### 17.2.5 Prazo entre Publicação e Abertura (`prazo_dias`)

**Decisão v2.8:** O prazo é calculado na **stored procedure** (`sp_itens_licitacoes_pbi`), usando as datas da view de **licitações** consolidada — não da view de itens.

```sql
-- Na #temp_censura (Passo 1 da SP):
SELECT Cod_licitacao, Situacao_Gerada, qtd_itens_sigilosos,
       data_primeira_publicacao, data_abertura
INTO #temp_censura FROM compras.vw_licitacoes_consolidada_sc;

-- No SELECT final (Passo 2):
DATEDIFF(day, cens.data_primeira_publicacao, cens.data_abertura) 
    AS 'Prazo entre Publicação e Abertura'
```

**Justificativa:** As datas de publicação e abertura são atributos da **licitação**, não do item. Calculando na SP:
- Funciona para **todas as fontes** (FaseExterna, Comprasnet, Siasg, PNCP)
- Usa a `data_primeira_publicacao` já consolidada (com hierarquia Alice → fallback por fonte)
- Evita trazer campos de data duplicados na view de itens

### 17.3 Fornecedor Vencedor e Valores Adjudicados por Fonte

#### 17.3.1 FaseExterna

O fornecedor vencedor é identificado pela proposta com `situacao = '6'` (Proposta Adjudicada) na tabela `proposta_item`, vinculada à `participacao` para obter CNPJ e dados cadastrais.

Campos trazidos: `cnpj_fornecedor`, `nome_fornecedor`, `porte_fornecedor`, `tipo_fornecedor`, `marca_fabricante`, `modelo_versao`, `quantidade_ofertada`, `valor_unitario_homologado`, `valor_proposta_calculado`, `valor_lance_calculado`, `valor_negociado_julgamento_calculado`.

**`valor_unitario_homologado` (v2.8, corrigido v2.9):** Calculado como `COALESCE(valor_negociado_julgamento_calculado, valor_lance_calculado, melhor_valor_proposta_lance_calculado, valor_proposta_calculado)` — o preço unitário final do fornecedor vencedor, seguindo a mesma hierarquia de valores do §5.2. Só é preenchido quando `item.situacao = '1'` (ativo) e existe proposta adjudicada (`proposta_item.situacao = '6'`). O campo `item.homologado` **não é mais usado** como condição (ver §5.1).

O valor adjudicado calculado segue a fórmula documentada no §5.2 (sempre `quantidade × valor_unitário`).

#### 17.3.2 Siasg DW

O fornecedor vencedor é obtido via `F_ITEM_FORNECEDOR` (fato) + `D_FRND_FORNECEDOR` (dimensão) e tabelas auxiliares de localização e classificação:

```sql
-- Fornecedor vencedor (homologado)
LEFT JOIN [db_dwsiasg].[dbo].[F_ITEM_FORNECEDOR] AS f_item_forn
    ON f_item.ID_ITCP_ITEM_COMPRA = f_item_forn.ID_ITCP_ITEM_COMPRA
    AND f_item_forn.VL_PRECO_TOTAL_HOMOLOG > 0

-- Dimensão do fornecedor (ATENÇÃO: tabela D_FRND, não D_FORN)
LEFT JOIN [db_dwsiasg].[dbo].[D_FRND_FORNECEDOR] AS fornecedor
    ON f_item_forn.ID_FRND_FORNECEDOR_COMPRA = fornecedor.ID_FRND_FORNECEDOR

-- Dimensões auxiliares do fornecedor
LEFT JOIN [db_dwsiasg].[dbo].[D_FRND_TP_PESSOA_FORNEC] AS tp_pessoa ...
LEFT JOIN [db_dwsiasg].[dbo].[D_FRND_NATUREZA_JURIDICA] AS juridica ...
LEFT JOIN [db_dwsiasg].[dbo].[D_FRND_PORTE_EMPRESA] AS porte ...
LEFT JOIN [db_dwsiasg].[dbo].[D_LCAL_UF] AS UF_fornecedor ...
LEFT JOIN [db_dwsiasg].[dbo].[D_LCAL_MUNICIPIO] AS fornecedor_munic ...
LEFT JOIN [db_dwsiasg].[dbo].[D_LCAL_REGIAO] AS regiao_fornecedor ...
```

**Campos do fornecedor vencedor disponíveis no Siasg DW:**

| Campo na view | Origem | Tabela |
|---------------|--------|--------|
| `id_fornecedor` | `ID_FRND_FORNECEDOR` | `D_FRND_FORNECEDOR` |
| `nome_fornecedor` | `NO_FRND_FORNECEDOR` | `D_FRND_FORNECEDOR` |
| `tipo_pessoa_fornecedor` | `DS_FRND_TP_PESSOA_FORNEC` | `D_FRND_TP_PESSOA_FORNEC` |
| `natureza_juridica_fornecedor` | `DS_FRND_NATUREZA_JURIDICA` | `D_FRND_NATUREZA_JURIDICA` |
| `porte_fornecedor` | `DS_FRND_PORTE_EMPRESA` | `D_FRND_PORTE_EMPRESA` |
| `uf_fornecedor` | `DS_LCAL_UF` | `D_LCAL_UF` |
| `id_municipio_fornecedor` | `ID_LCAL_MUNICIPIO` | `D_LCAL_MUNICIPIO` |
| `municipio_fornecedor` | `DS_LCAL_MUNICIPIO` | `D_LCAL_MUNICIPIO` |
| `regiao_fornecedor` | `DS_LCAL_REGIAO` | `D_LCAL_REGIAO` |
| `quantidade_ofertada` | `QT_OFERTADA` | `F_ITEM_FORNECEDOR` |
| `valor_unitario_homologado` | `VL_PRECO_UNIT_HOMOLOG` | `F_ITEM_FORNECEDOR` |
| `valor_adjudicado_calculado` | `VL_PRECO_TOTAL_HOMOLOG` | `F_ITEM_FORNECEDOR` |

**⚠️ Erros corrigidos na v2.0 da view:**
- Tabela do fornecedor: `D_FRND_FORNECEDOR` (não `D_FORN_FORNECEDOR`)
- FK: `ID_FRND_FORNECEDOR_COMPRA` → `ID_FRND_FORNECEDOR` (não `ID_FORN_FORNECEDOR`)
- Porte: via tabela separada `D_FRND_PORTE_EMPRESA` (não campo direto do fornecedor)
- Adicionadas 6 dimensões auxiliares que estavam faltando

> **Observação:** O filtro `VL_PRECO_TOTAL_HOMOLOG > 0` no JOIN com `F_ITEM_FORNECEDOR` apenas identifica vencedores no JOIN, sem excluir itens que ainda não têm adjudicação.

#### 17.3.3 Comprasnet

A versão do Comprasnet disponível na CGU (`db_compras`) **não possui** a tabela `TBL_PROPOSTAITEM`, que conteria os dados de propostas aceitas, habilitadas e adjudicadas. Por isso, **não é possível obter fornecedor vencedor nem valores adjudicados** a partir do Comprasnet. Ver §5.3 para detalhes.

### 17.4 Classificação de Material/Serviço — Hierarquia por Fonte

#### 17.4.1 Hierarquia de Classificação

A classificação segue uma hierarquia de 4 níveis, do mais amplo ao mais granular:

```
Tipo Material/Serviço → Grupo Material (ou Serviço) → Classe → Material/Serviço (item individual)
```

#### 17.4.2 Tabelas de Dimensão do Siasg DW (db_dwsiasg)

| Nível | Tabela | PK | Descrição |
|-------|--------|-----|-----------|
| Tipo | `D_ITCP_TP_MATERIAL_SERVICO` | `ID_ITCP_TP_MATERIAL_SERVICO` | Tipo mais amplo (Material ou Serviço) |
| Grupo Material | `D_ITCP_GRUPO_MATERIAL` | `ID_ITCP_GRUPO_MATERIAL` | Grupo de material (ex: "Material de Escritório") |
| Grupo Serviço | `D_ITCP_GRUPO_SERVICO` | `ID_ITCP_GRUPO_SERVICO` | Grupo de serviço (ex: "Serviços de Limpeza") |
| Classe | `D_ITCP_CLASSE_MAT_SERV` | `ID_ITCP_CLASSE_MAT_SERV` | Classe do material/serviço |
| Material/Serviço | `D_ITCP_MATERIAL_SERVICO` | `ID_ITCP_MATERIAL_SERVICO` | Item individual (mais granular) |

**Navegação:** A tabela `D_ITCP_MATERIAL_SERVICO` contém FKs para todas as outras dimensões, servindo como ponto de entrada para a cadeia completa de classificação. O JOIN na view de itens Siasg usa `f_item.ID_ITCP_TP_COD_MAT_SERV` (coluna da tabela fato `F_ITEM_COMPRA`) como chave de entrada.

> **⚠️ ATENÇÃO (v2.8):** `ID_ITCP_MATERIAL_SERVICO` **NÃO é chave única** na `D_ITCP_MATERIAL_SERVICO`. O mesmo código pode existir em duas linhas — uma como Material (`ID_ITCP_GRUPO_MATERIAL > 0`) e outra como Serviço (`ID_ITCP_GRUPO_SERVICO > 0`). Ver §17.4.5 para a regra de desambiguação.

#### 17.4.3 Tabelas Equivalentes no Comprasnet (db_compras)

| Nível Siasg DW | Tabela Comprasnet | PK | Campo em TB_COMPRAS_MAT |
|----------------|-------------------|-----|------------------------|
| Grupo Material | `TB_GRUPO_MATERIAL` | `codgrpmat` | `codgrpmat` |
| Grupo Serviço | `TB_GRUPO_SERVICO` | `codgrpserv` | `codgrpserv` (em TB_COMPRAS_SERV) |
| Classe Material | `TB_CLASSE_MATERIAL` | `codclassemat` | `codclassemat` |
| Material (item) | `TB_MATERIAL` / `TB_LINHA` | `codconjmat` | `codconjmat` |
| Serviço (item) | `TB_SERVICO` | `codserv` | `codserv` (em TB_COMPRAS_SERV) |

**Correspondência entre Comprasnet e Siasg DW:**
- `codgrpmat` ↔ `ID_ITCP_GRUPO_MATERIAL` — Códigos compatíveis (mesma origem: SIASG mainframe)
- `codgrpserv` ↔ `ID_ITCP_GRUPO_SERVICO` — Códigos compatíveis
- `codclassemat` ↔ `ID_ITCP_CLASSE_MAT_SERV` — Códigos compatíveis
- `codconjmat` ↔ `ID_ITCP_MATERIAL_SERVICO` — Códigos compatíveis (ambos representam o item individual)

> **Nota:** Tanto o Comprasnet quanto o Siasg DW são alimentados pelo SIASG mainframe via carga diária, por isso os códigos são intercambiáveis.

#### 17.4.4 Disponibilidade de Classificação por Fonte de Itens

| Campo | FaseExterna | Siasg DW | Comprasnet | PNCP |
|-------|-------------|----------|------------|------|
| `ID_ITCP_MATERIAL_SERVICO` | ✅ (via `codigo_item_catalogo`) | ✅ (via `f_item.ID_ITCP_TP_COD_MAT_SERV`) | ⚠️ Material: `codconjmat`; Serviço: não disponível | ❌ |
| `DS_ITCP_MATERIAL_SERVICO` | ✅ | ✅ | ⚠️ Via `TB_MATERIAL.nomconjmat` | ❌ |
| `ID_ITCP_GRUPO_MATERIAL` | ✅ | ✅ | ✅ (`codgrpmat`) | ❌ |
| `ID_ITCP_GRUPO_SERVICO` | ✅ | ✅ | ✅ (`codgrpserv`) | ❌ |
| `ID_ITCP_CLASSE_MAT_SERV` | ✅ | ✅ | ✅ (`codclassemat`) | ❌ |
| `ID_ITCP_TP_MATERIAL_SERVICO` | ✅ | ✅ | ❌ | ❌ |

#### 17.4.5 Desambiguação de Material/Serviço — `D_ITCP_MATERIAL_SERVICO` não é única

> **Problema descoberto em março/2026:** A tabela `D_ITCP_MATERIAL_SERVICO` do Siasg DW pode ter **duas linhas com o mesmo `ID_ITCP_MATERIAL_SERVICO`** — uma classificada como Material e outra como Serviço. O mesmo código (ex: 21784) aparece como:
>
> | ID_ITCP_MATERIAL_SERVICO | ID_ITCP_GRUPO_MATERIAL | ID_ITCP_GRUPO_SERVICO | DS_ITCP_MATERIAL_SERVICO |
> |---|---|---|---|
> | 21784 | 61 (>0) | -9 | FUNIL LABORATÓRIO |
> | 21784 | -9 | 871 (>0) | INSTALAÇÃO/MANUTENÇÃO HIDROSSANITÁRIAS |
>
> Um LEFT JOIN sem filtro retorna **duas linhas por item**, duplicando registros.

**Solução por fonte:**

| Fonte | Chave de JOIN | Desambiguação | Risco de duplicação |
|-------|--------------|---------------|---------------------|
| **Siasg DW** | `f_item.ID_ITCP_TP_COD_MAT_SERV` | Chave é **única** (PK composta com tipo). Sem risco. | ❌ Nenhum |
| **FaseExterna** | `TRY_CAST(codigo_item_catalogo AS INT)` | Precisa filtrar por `tipo_item_catalogo` ('M'/'S') | ✅ **Corrigido v2.8** |
| **Comprasnet** | `codgrpmat` → `D_ITCP_GRUPO_MATERIAL` | JOIN direto com tabela de grupo (não passa por `D_ITCP_MATERIAL_SERVICO`). Sem risco. | ❌ Nenhum |

**Correção no FaseExterna (v2.8):**

```sql
-- O campo tipo_item_catalogo ('M' ou 'S') do FaseExterna desambigua a linha correta:
LEFT JOIN D_ITCP_MATERIAL_SERVICO AS mat_serv
    ON TRY_CAST(i.codigo_item_catalogo AS INT) = mat_serv.ID_ITCP_MATERIAL_SERVICO
    AND (
        (i.tipo_item_catalogo = 'M' AND mat_serv.ID_ITCP_GRUPO_MATERIAL > 0)
        OR (i.tipo_item_catalogo = 'S' AND mat_serv.ID_ITCP_GRUPO_SERVICO > 0)
        OR (i.tipo_item_catalogo NOT IN ('M','S'))  -- fallback para tipos desconhecidos
    )
```

**Por que o Siasg DW não tem esse problema:** No DW, a tabela fato `F_ITEM_COMPRA` usa `ID_ITCP_TP_COD_MAT_SERV` como FK — essa coluna **já inclui o tipo** na chave, então o JOIN é 1:1 por natureza.

### 17.5 Considerações Técnicas para Consultas ao Siasg DW (Itens)

O Siasg DW parou de ser atualizado em abril/2024. Ao consultá-lo para itens:

- **NÃO usar filtros restritivos** que excluam licitações não homologadas (ver §2.1.1 original)
- **NÃO usar situações de suspensão** (código 119 e eventos 93-100) — estados temporários que podem ter mudado após a parada
- Usar apenas **situações permanentes**: Revogada, Anulada, Cancelada, Homologada

**Estrutura recomendada para consultas ao Siasg:**
```sql
FROM [db_dwsiasg].[dbo].[D_CMPR_COMPRA] AS C

LEFT JOIN [db_dwsiasg].[dbo].[D_UNDD_UNIDADE] AS uasg
    ON C.ID_UNDD_RESP_COMPRA = uasg.ID_UNDD_UNIDADE

JOIN temp_CGUSC.dbo.vw_jurisdicionadas_sc AS j
    ON j.UASG = uasg.CD_UNDD_UNIDADE

LEFT JOIN [db_dwsiasg].[dbo].[F_ITEM_COMPRA] AS f_item
    ON C.ID_CMPR_COMPRA = f_item.ID_CMPR_COMPRA

LEFT JOIN [db_dwsiasg].[dbo].[F_ITEM_FORNECEDOR] AS f_item_forn
    ON f_item.ID_ITCP_ITEM_COMPRA = f_item_forn.ID_ITCP_ITEM_COMPRA
    AND f_item_forn.VL_PRECO_TOTAL_HOMOLOG > 0

WHERE uasg.ID_LCAL_UF_UNIDADE = 'SC'
  AND YEAR(C.DT_CMPR_RESULTADO_COMPRA) >= 2022
```

| ❌ Evitar | ✅ Correto | Motivo |
|-----------|------------|--------|
| `INNER JOIN F_COMPRA` | Não usar `F_COMPRA` ou usar `LEFT JOIN` | `F_COMPRA` só tem registros com valores, excluindo compras em andamento |
| `F_COMPRA.VL_COMPRA > 0` | Remover este filtro | Exclui todas as compras não homologadas |
| `INNER JOIN D_UNDD_UNIDADE` | `LEFT JOIN D_UNDD_UNIDADE` | Algumas compras podem não ter detalhes de UASG preenchidos |

#### 17.5.1 Segurança de Tipos em UNION ALL (Lição v2.8)

Ao consolidar 3+ fontes em UNION ALL, o SQL Server escolhe o tipo de **maior precedência** para cada coluna posicional. Conflitos entre VARCHAR e INT/SMALLINT causam erros em tempo de execução quando o valor VARCHAR não é conversível.

**Conflitos encontrados e corrigidos na v2.8:**

| Coluna | FaseExterna | Siasg DW | Comprasnet | Solução |
|--------|-------------|----------|------------|---------|
| `criterio_valor` | varchar(1) com `'E'` | varchar(22) | **smallint** | `CAST(... AS VARCHAR(50))` nas 3 partes |
| `codigo_item_catalogo` | int | numeric(9,0) | varchar(8) | `CAST(... AS VARCHAR(50))` nas 3 partes |
| `id_fornecedor` | NULL (precisava INT→VARCHAR) | varchar(14) = CNPJ | NULL | `CAST(NULL AS VARCHAR(20))` |
| `ID_ITCP_PADRAO_DESC_MAT` | NULL (precisava INT→VARCHAR) | varchar(5) | NULL | `CAST(NULL AS VARCHAR(10))` |

**Regra geral:** Ao adicionar colunas com `CAST(NULL AS ...)` para fontes que não têm o campo, usar `sp_describe_first_result_set` na fonte que TEM o campo para verificar o tipo real, e usar o mesmo tipo (ou VARCHAR compatível) no CAST.

**Diagnóstico:** Usar `sp_describe_first_result_set` em cada view base e comparar tipos por nome de coluna (não por posição — as views podem ter números de colunas diferentes).

### 17.6 Performance — Consulta de Itens para o Power BI

#### 17.6.1 Problema de Performance

O JOIN entre `vw_itens_consolidada_sc` e `vw_licitacoes_consolidada_sc` (necessário para censura de sigilo) causa timeout no SQL Server (>1h de execução). O problema ocorre porque:

- Ambas as views referenciam internamente tabelas base em comum (ex: `vw_licitacoes_faseexterna_sc`)
- O otimizador do SQL Server **mescla os planos de execução** das views, expandindo todas as colunas
- Mesmo selecionando apenas 3 colunas da consolidada, o SQL Server expande a view inteira no plano
- Views são transparentes para o otimizador — não funcionam como barreira de execução

#### 17.6.2 Solução: Stored Procedure com Tabela Temporária

A `sp_itens_licitacoes_pbi` resolve o problema forçando planos separados via `#temp`:

```
Passo 1: SELECT 5 campos → #temp_censura                    (~3 min, plano isolado)
         (Cod_licitacao, Situacao_Gerada, qtd_itens_sigilosos,
          data_primeira_publicacao, data_abertura)
Passo 2: CREATE INDEX na #temp_censura                    (instantâneo)  
Passo 3: SELECT itens JOIN #temp_censura                  (~2 min, plano isolado)
Total estimado: ~5-8 min (vs >1h com JOIN direto)
```

A tabela temporária atua como **barreira de otimização** — o SQL Server é obrigado a completar o Passo 1 antes de iniciar o Passo 3, com planos de execução independentes.

#### 17.6.3 Censura de Sigilo nos Itens

A censura nos itens é aplicada a **nível de licitação** (não de item individual):

**Regra:** Quando `Situacao_Gerada = 'Não Homologada'` E `qtd_itens_sigilosos > 0`:
→ Zerar TODOS os valores de TODOS os itens daquela licitação, independente do item individual ser sigiloso ou não.

**10 campos zerados pela censura:**
1. `valor_estimado` (unitário)
2. `valor_estimado_calculado`
3. `valor_unitario_homologado`
4. `melhor_valor_proposta_lance_calculado`
5. `melhor_valor_proposta_lance_informado`
6. `melhor_valor_nao_desclassificado_calculado`
7. `valor_proposta_calculado`
8. `valor_lance_calculado`
9. `valor_negociado_julgamento_calculado`
10. `valor_adjudicado_calculado`

**Campos NÃO censurados** (não são valores monetários sigilosos):
- `qtd_lances_item` — quantidade de lances
- `qtd_fornecedores_propostas` — número de fornecedores com proposta

#### 17.6.4 Uso no Power BI

No Power Query (modo Importação), usar como fonte SQL:
```sql
EXEC temp_CGUSC.compras.sp_itens_licitacoes_pbi
```

---

## 18. Contatos

- **Responsável Técnica:** Tatiana Popia Corrêa
- **Unidade:** NEP / CGU Regional Santa Catarina
- **Demandante:** João Marcelo Martins (NAC2)

---

## 19. Histórico de Alterações

### 19.1 Versão 1.x — Primeira Geração (Abr/2024 – Dez/2025)

> **Nota:** A série 1.x utilizava arquitetura de views distinta da v2.0. As views `vw_adjudicado_comprasgov_SC` e `vw_valor_estimado_comprasgov_SC` criadas na v1.3.3 foram as precursoras diretas da integração completa do FaseExterna realizada na v2.0.

| Data | Versão | Alteração |
|------|--------|-----------|
| Abril/2024 | **1.0** | **Criação inicial do painel** com visão geral e valores de orçamentos sigilosos das UASGs jurisdicionadas. Tabela `LicitacoesSC` no Power BI. |
| 2024 | 1.0.1 | Expansão para incluir visões de itens de licitações. Inclusão de visão geral, listagem e itens de dispensas e inexigibilidades. Novas tabelas no PBI: `ItensLicitacao`, `DispInex` e `ItensDispInex`. |
| 2024 | **1.1** | **Renomeado para "Painel de Licitações"**. Separação em versões de homologação e produção. Recriação estrutural das views. Inclusão do campo de data de publicação, tipo de administração da unidade e nome da modalidade. Novas situações Revogada e Anulada em `situacao_gerada`. |
| 2024 | 1.1.1 | Migração das views para `temp_CGUSC`, garantindo mais perenidade ao projeto. Separação dos painéis PBI em produção/homologação. Separação do painel de detalhamento em homologadas/não homologadas. Criação das abas Gráfico Temporal (quantidades e valores) e Gráfico Unidades. Novas tabelas PBI: `Calendario` e `UASGs`. |
| Outubro/2024 | **1.2** | **Renomeado para "Monitor de Compras"** (nome definitivo). Aprimoramento dos filtros (exibir "todos selecionados"). Inclusão da aba de Indicadores. Medidas das linhas dos gráficos temporais V e Q. Criação da pasta de Relatórios de Atividades. |
| 2024–2025 | 1.2.1 | Dados dos fornecedores nos itens. Campo "Situação Pregão". Subpainel de Alertas Alice nos Indicadores; tabela Alertas no PBI. Grupo do item e número de fornecedores com lance. Cruzamento com `db_portal` na view de jurisdicionadas para obter UG correta. Separação da Visão Geral em Homologadas/Não Homologadas. |
| 2025 | **1.3** | Capa de apresentação para os painéis. Transferência para a nuvem. Menu com submenu e imagens geradas por IA. Correção dos bugs de filtro do gráfico temporal. |
| 2025 | 1.3.1 | Adaptação para cobrir 4 anos (2022–2025). Simplificação das medidas na aba Indicadores. Número de alertas na visualização detalhada. |
| 2025 | 1.3.2 | Correções de bugs e ajustes de exibição para apresentação à CGPLA. |
| 2025 | 1.3.3 | Detalhes das trilhas dos alertas nos Indicadores. Atualização das views 08 e 09 (Alice). Inclusão dos valores estimados do FaseExterna (ComprasGov) e valores adjudicados na consulta `LicitacoesSC`. Criação de `vw_adjudicado_comprasgov_SC` e `vw_valor_estimado_comprasgov_SC` — precursoras da integração completa da v2.0. |

---

### 19.2 Versão 2.x — Refatoração Completa (Jan–Mar/2026)

| Data | Versão | Alteração |
|------|--------|-----------|
| Janeiro/2026 | **2.0** | **Refatoração completa das views SQL** — reescrita da arquitetura com modularização por fonte de dados |
| Janeiro/2026 | 2.0.1 | Adição de campos `data_primeira_publicacao` e `data_publicacao_fonte` |
| Janeiro/2026 | 2.0.1 | Correção de tipos NULL na view de itens Comprasnet para compatibilidade UNION |
| Janeiro/2026 | 2.0.2 | Adição de campo `data_ultima_publicacao` |
| Janeiro/2026 | 2.0.2 | Correção de duplicatas: ROW_NUMBER na tb_compras ordenando por dataAlteracao |
| Janeiro/2026 | 2.0.2 | Correção de duplicatas: GROUP BY na vw_siasg_situacao_sc |
| Janeiro/2026 | **2.0.3** | **Integração do Siasg como terceira fonte de dados** |
| Janeiro/2026 | 2.0.3 | Criação da view `vw_licitacoes_siasg_sc` |
| Janeiro/2026 | 2.0.3 | Atualização da `vw_licitacoes_consolidada_sc` para UNION de 3 fontes |
| Janeiro/2026 | 2.0.3 | Remoção de campos da jurisdicionadas das views (relacionamento feito no Power BI) |
| Janeiro/2026 | 2.0.3 | Expansão do mapeamento de situações do Siasg |
| Janeiro/2026 | 2.0.3 | Documentação: considerações técnicas para consultas ao Siasg |
| Fevereiro/2026 | **2.0.4** | **Integração do PNCP como quarta fonte de dados** |
| Fevereiro/2026 | 2.0.4 | Criação da view `vw_disp_inex_pncp_sc` para Dispensas e Inexigibilidades |
| Fevereiro/2026 | 2.0.4 | Atualização da `vw_licitacoes_consolidada_sc` para UNION de 4 fontes |
| Fevereiro/2026 | 2.0.4 | Documentação: mapeamento completo do PNCP (modalidades, situações, valores) |
| Fevereiro/2026 | **2.0.5** | **Nova hierarquia de prioridade para ITENS** (diferente de licitações) |
| Fevereiro/2026 | 2.0.5 | Criação da view `vw_itens_siasg_sc` — itens do Siasg DW com fornecedor e classificação completa |
| Fevereiro/2026 | 2.0.5 | Criação da `sp_itens_licitacoes_pbi` — Stored Procedure para Power BI com censura (resolve timeout >1h) |
| Fevereiro/2026 | 2.0.5 | Documentação: hierarquia de classificação material/serviço (codconjmat ↔ ID_ITCP_MATERIAL_SERVICO) |
| Fevereiro/2026 | 2.0.5 | Documentação: correspondência de códigos Comprasnet ↔ Siasg DW (mesma origem SIASG mainframe) |
| Fevereiro/2026 | 2.0.5 | Documentação: problema de performance e solução com tabela temporária como barreira de otimização |
| Fevereiro/2026 | 2.0.5 | Documentação: regras de censura de sigilo a nível de item (10 campos zerados) |
| Fevereiro/2026 | **2.0.6** | **Reorganização: criação do §19 — Regras de Negócio de Itens** (centraliza todas as regras de itens) |
| Fevereiro/2026 | 2.0.6 | Movidos para §19: hierarquia de prioridade de itens (ex-§2.1.1), classificação material/serviço (ex-§15A), performance (ex-§15B), fornecedor vencedor (ex-§5.4) |
| Fevereiro/2026 | 2.0.6 | Novo §19.2: campos `qtd_lances_item` e `qtd_fornecedores_propostas` — decisões técnicas e disponibilidade por fonte |
| Fevereiro/2026 | 2.0.6 | Documentação: `QT_ITCP_LANCES_ITEM` (Siasg DW) não tem equivalente no FaseExterna |
| Fevereiro/2026 | 2.0.6 | Documentação: `qtde_propostas_melhor_valor` do FaseExterna retorna -1 na maioria dos casos (campo não confiável) |
| Fevereiro/2026 | **2.0.7** | **Correção `vw_itens_siasg_sc` v2.0** — JOINs corrigidos conforme consulta original `vw_valor_homologado_siasg_sc` |
| Fevereiro/2026 | 2.0.7 | Correção: tabela fornecedor `D_FRND_FORNECEDOR` (não `D_FORN_FORNECEDOR`), FK `ID_FRND_FORNECEDOR_COMPRA` |
| Fevereiro/2026 | 2.0.7 | Correção: JOIN material/serviço via `f_item.ID_ITCP_TP_COD_MAT_SERV` (da fato, não via d_item) |
| Fevereiro/2026 | 2.0.7 | Correção: `numero_item` via `RIGHT(CH_ITCP_ITEM_COMPRA, 5)`, `quantidade_solicitada` via `QT_ITCP_SOLICITADA` |
| Fevereiro/2026 | 2.0.7 | Adicionadas 6 dimensões do fornecedor: tipo pessoa, natureza jurídica, porte (via tabela separada), UF, município, região |
| Fevereiro/2026 | 2.0.7 | Adicionados campos: `VL_ITCP_PRECO_UNIT_ESTIM`, `VL_PRECO_UNIT_HOMOLOG`, `QT_OFERTADA`, `DT_ULT_HOMOLOGACAO`, `prazo_dias` |
| Fevereiro/2026 | 2.0.7 | Adicionadas 8 dimensões indicadoras do item: critério julgamento, critério valor, grupo compra, desempate ME, tipo objeto, sigilo (desc), sit. catálogo, PDM |
| Fevereiro/2026 | 2.0.7 | Novo §17.2.3: documentação completa dos campos adicionais do Siasg DW e correção do JOIN de classificação |
| Março/2026 | **2.0.8** | **Correção crítica: `valor_estimado` no FaseExterna é SEMPRE unitário** — não depende de SRP/Normal. Views de itens e licitações corrigidas. |
| Março/2026 | 2.0.8 | Correção: `valor_adjudicado_calculado` no FaseExterna — sempre multiplicar quantidade × valor unitário (§5.2 atualizado) |
| Março/2026 | 2.0.8 | Correção: `valor_estimado_total`, `valor_estimado_sigiloso`, `valor_adjudicado_total`, `valor_adjudicado_sigiloso` na `vw_licitacoes_faseexterna_sc` |
| Março/2026 | 2.0.8 | Correção: `numero_grupo` no Comprasnet — valores sentinela (0, -1, -2, -3) tratados como NULL (§17.2.4) |
| Março/2026 | 2.0.8 | Melhoria: `prazo_dias` calculado na SP via `DATEDIFF(data_primeira_publicacao, data_abertura)` da view de licitações, cobrindo todas as fontes (§17.2.5) |
| Março/2026 | 2.0.8 | Melhoria: `#temp_censura` ampliada para 5 campos (+ `data_primeira_publicacao`, `data_abertura`) |
| Março/2026 | 2.0.8 | Correção: `criterio_valor` — CAST para VARCHAR(50) nas 3 partes da consolidada (Comprasnet era SMALLINT, causava erro com valor 'E' do FaseExterna) |
| Março/2026 | 2.0.8 | Correção: `id_fornecedor` — CAST para VARCHAR(20) (contém CNPJ, estourava INT); `ID_ITCP_PADRAO_DESC_MAT` — CAST para VARCHAR(10) |
| Março/2026 | 2.0.8 | Correção: `codigo_item_catalogo` — CAST para VARCHAR(50) nas 3 partes da consolidada (conflito INT vs VARCHAR no UNION) |
| Março/2026 | 2.0.8 | Correção: JOIN FaseExterna com DW — `TRY_CAST(codigo_item_catalogo AS INT)` para evitar falha na conversão de valores não-numéricos |
| Março/2026 | 2.0.8 | **Correção: duplicação de itens no FaseExterna** — `D_ITCP_MATERIAL_SERVICO` não é PK única (mesmo código como Material e Serviço). JOIN desambiguado com `tipo_item_catalogo` (§17.4.5) |
| Março/2026 | 2.0.8 | Melhoria: `valor_unitario_homologado` agora disponível no FaseExterna — calculado como `COALESCE(valor_negociado, valor_lance, melhor_valor)` (§17.3.1) |
| Março/2026 | **2.0.9** | **Correção crítica: `item.homologado` removido das condições de valor adjudicado** — campo não confiável (35% falsos negativos). Proposta `situacao='6'` é condição suficiente (§5.1, §5.2). |
| Março/2026 | 2.0.9 | Correção em `vw_itens_faseexterna_sc`: `valor_unitario_homologado` e `valor_adjudicado_calculado` não exigem mais `homologado='S'` |
| Março/2026 | 2.0.9 | Correção em `vw_licitacoes_faseexterna_sc`: `valor_adjudicado_total` e `valor_adjudicado_sigiloso` não exigem mais `homologado='S'` |
| Março/2026 | 2.0.9 | Análise: 159.943 de 456.276 licitações homologadas (35%) tinham propostas adjudicadas com `item.homologado='N'` — valores adjudicados estavam zerados |
| Março/2026 | 2.0.9 | **Correção: ROW_NUMBER com desempate por `id DESC`** — itens recriados com novos IDs e mesma `versao` causavam seleção aleatória do registro (§14.1.1) |
| Março/2026 | 2.0.9 | Correção aplicada em `vw_itens_faseexterna_sc` e `vw_licitacoes_faseexterna_sc` (CTEs `compras_recentes` e `itens_recentes`) |
| Março/2026 | 2.0.9 | Melhoria: `valor_proposta_calculado` adicionado como 4º fallback na hierarquia de valores adjudicados (§5.2) — resolve Concorrências com modo "Fechado" sem lances |
| Março/2026 | 2.0.9 | Documentação: §14.5 — 10.206 licitações do FaseExterna (2%) sem itens carregados, valores zerados. Limitação de dados das fontes. |


