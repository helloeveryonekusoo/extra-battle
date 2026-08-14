import aliasesJson from '../../../data/aliases.json';
import bannedJson from '../../../data/banned.json';
import exclusiveGroupsJson from '../../../data/exclusiveGroups.json';
import type { CardText, Printing } from './types';

export type DeckValidationCode =
  | 'DECK_SIZE'
  | 'NO_BASIC_POKEMON'
  | 'CARD_LIMIT'
  | 'ACE_SPEC_LIMIT'
  | 'RADIANT_LIMIT'
  | 'PRISM_LIMIT'
  | 'BANNED_CARD'
  | 'OUT_OF_FORMAT'
  | 'ALIAS_LIMIT'
  | 'EXCLUSIVE_GROUP';

export interface DeckValidationIssue {
  code: DeckValidationCode;
  severity: 'error';
  message: string;
  cardNames: string[];
}

export interface DeckEntry {
  card: CardText;
  count: number;
  printing?: Printing;
}

export interface AliasData {
  format: string;
  updatedAt: string;
  groups: { canonical: string; names: string[] }[];
}

export interface ExclusiveGroupData {
  format: string;
  updatedAt: string;
  groups: { id: string; names: string[]; maxDistinct: number }[];
}

export interface BannedData {
  format: string;
  updatedAt: string;
  source: string;
  cards: string[];
}

export interface DeckValidationData {
  aliases: AliasData;
  exclusiveGroups: ExclusiveGroupData;
  banned: BannedData;
}

export const DEFAULT_DECK_VALIDATION_DATA: DeckValidationData = {
  aliases: aliasesJson,
  exclusiveGroups: exclusiveGroupsJson,
  banned: bannedJson,
};

const issue = (
  code: DeckValidationCode,
  message: string,
  cardNames: string[] = [],
): DeckValidationIssue => ({ code, severity: 'error', message, cardNames });

const positiveEntries = (entries: readonly DeckEntry[]) =>
  entries
    .map((entry) => ({ ...entry, count: Math.max(0, Math.trunc(entry.count)) }))
    .filter((entry) => entry.count > 0);

function addCount(map: Map<string, number>, name: string, count: number): void {
  map.set(name, (map.get(name) ?? 0) + count);
}

/** 印刷情報がエクストラ（BW以降、または再録利用可）かを判定する。 */
export function isExtraFormatPrinting(printing: Printing | undefined): boolean {
  if (!printing || printing.extraLegalReprint) return true;
  if (printing.era) return printing.era !== 'pre-BW';
  const code = printing.setCode.trim().toUpperCase();
  return /^(BW|XY|CP|SM|S(?!M)|SV|20TH)/.test(code);
}

/**
 * エクストラ用デッキを検証する純粋関数。
 * 引数以外の状態を変更せず、同じ入力には常に同じ順序の結果を返す。
 */
export function validateDeck(
  rawEntries: readonly DeckEntry[],
  data: DeckValidationData = DEFAULT_DECK_VALIDATION_DATA,
): DeckValidationIssue[] {
  const entries = positiveEntries(rawEntries);
  const issues: DeckValidationIssue[] = [];
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);

  if (total !== 60) {
    issues.push(issue('DECK_SIZE', `デッキは60枚必要です（現在${total}枚）`));
  }
  if (
    !entries.some(
      (entry) =>
        entry.card.supertype === 'pokemon' &&
        entry.card.stage === 'basic' &&
        entry.count > 0,
    )
  ) {
    issues.push(issue('NO_BASIC_POKEMON', 'たねポケモンを1枚以上入れてください'));
  }

  const byExactName = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.card.isBasicEnergy) addCount(byExactName, entry.card.name, entry.count);
  }
  for (const [name, count] of byExactName) {
    if (count > 4) {
      issues.push(issue('CARD_LIMIT', `「${name}」は4枚までです（現在${count}枚）`, [name]));
    }
  }

  const aceSpecCount = entries.reduce(
    (sum, entry) => sum + (entry.card.isAceSpec ? entry.count : 0),
    0,
  );
  if (aceSpecCount > 1) {
    issues.push(issue('ACE_SPEC_LIMIT', `ACE SPECはデッキ全体で1枚までです（現在${aceSpecCount}枚）`));
  }

  const radiant = entries.filter((entry) => entry.card.ruleBox === 'RADIANT');
  const radiantCount = radiant.reduce((sum, entry) => sum + entry.count, 0);
  if (radiantCount > 1) {
    issues.push(
      issue(
        'RADIANT_LIMIT',
        `かがやくポケモンはデッキ全体で1枚までです（現在${radiantCount}枚）`,
        radiant.map((entry) => entry.card.name),
      ),
    );
  }

  const prismByName = new Map<string, number>();
  for (const entry of entries) {
    if (entry.card.ruleBox === 'PRISM') addCount(prismByName, entry.card.name, entry.count);
  }
  for (const [name, count] of prismByName) {
    if (count > 1) {
      issues.push(issue('PRISM_LIMIT', `プリズムスター「${name}」は1枚までです`, [name]));
    }
  }

  const banned = new Set(data.banned.cards);
  for (const entry of entries) {
    const printingName = entry.printing ? `${entry.card.name}(${entry.printing.setCode})` : null;
    if (banned.has(entry.card.name) || (printingName !== null && banned.has(printingName))) {
      issues.push(issue('BANNED_CARD', `「${printingName ?? entry.card.name}」は禁止カードです`, [entry.card.name]));
    }
    if (!isExtraFormatPrinting(entry.printing)) {
      issues.push(
        issue(
          'OUT_OF_FORMAT',
          `「${entry.card.name}」の${entry.printing?.setCode ?? 'この版'}はエクストラで使用できません`,
          [entry.card.name],
        ),
      );
    }
  }

  const aliasCanonical = new Map<string, string>();
  for (const group of data.aliases.groups) {
    for (const name of group.names) aliasCanonical.set(name, group.canonical);
  }
  const byAlias = new Map<string, { count: number; originals: Set<string> }>();
  for (const entry of entries) {
    if (entry.card.isBasicEnergy) continue;
    const canonical = aliasCanonical.get(entry.card.name);
    if (!canonical) continue;
    const current = byAlias.get(canonical) ?? { count: 0, originals: new Set<string>() };
    current.count += entry.count;
    current.originals.add(entry.card.name);
    byAlias.set(canonical, current);
  }
  for (const [canonical, value] of byAlias) {
    if (value.count > 4) {
      issues.push(
        issue(
          'ALIAS_LIMIT',
          `「${canonical}」として扱うカードは合計4枚までです（現在${value.count}枚）`,
          [...value.originals],
        ),
      );
    }
  }

  const presentCanonicalNames = new Set(
    entries.map((entry) => aliasCanonical.get(entry.card.name) ?? entry.card.name),
  );
  for (const group of data.exclusiveGroups.groups) {
    const present = group.names.filter((name) => presentCanonicalNames.has(name));
    if (present.length > group.maxDistinct) {
      issues.push(
        issue(
          'EXCLUSIVE_GROUP',
          `「${present.join('」「')}」は同じデッキに入れられません`,
          present,
        ),
      );
    }
  }

  return issues;
}
