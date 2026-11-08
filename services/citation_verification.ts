import { locateUniqueReaderQuote } from './reader_service.js';
import { legacyReaderToolsSourceHash, READER_SOURCE_HASH_VERSION, readerParagraphHash, readerToolsSourceHash } from './reader_tools_service.js';

export type CitationVerificationState =
  | 'verified'
  | 'paragraph_edited'
  | 'quote_moved'
  | 'quote_removed'
  | 'ambiguous'
  | 'text_missing'
  | 'source_missing'
  | 'hash_version_stale'
  | 'missing';

export type CitationVerification = {
  verification: CitationVerificationState;
  sourceRevisedElsewhere: boolean;
  currentParagraphIndex: number | null;
};

export function verifyCitation(input: {
  citation: {
    quoteText: string;
    paragraphHash: string | null;
    bodyHash: string;
    paragraphIndex: number;
    hashVersion: number;
    sourceCardId: string | null;
  };
  currentParagraphs: string[] | null;
}): CitationVerification {
  const { citation, currentParagraphs } = input;
  const result = (verification: CitationVerificationState, currentParagraphIndex: number | null = null, sourceRevisedElsewhere = false): CitationVerification => ({ verification, currentParagraphIndex, sourceRevisedElsewhere });
  if (!citation.sourceCardId) return result('source_missing');
  if (!currentParagraphs?.length) return result('text_missing');
  if (!Number.isInteger(citation.paragraphIndex) || citation.paragraphIndex < 0 || citation.paragraphIndex >= currentParagraphs.length) {
    // Keep the historical status for malformed legacy positions; the quote may
    // still be found, so callers can offer a safe explicit repair.
    const misplaced = locateUniqueReaderQuote(citation.quoteText, currentParagraphs, citation.paragraphIndex);
    if (misplaced.status === 'moved') return result('quote_moved', misplaced.paragraphIndex, true);
    if (misplaced.status === 'ambiguous') return result('ambiguous', null, true);
    if (misplaced.status === 'matched') return result('missing', misplaced.paragraphIndex, true);
    return result('missing', null, true);
  }

  const isLegacy = citation.hashVersion < READER_SOURCE_HASH_VERSION || citation.paragraphHash === null;
  const currentBodyHash = isLegacy ? legacyReaderToolsSourceHash(currentParagraphs) : readerToolsSourceHash(currentParagraphs);
  const sourceRevisedElsewhere = currentBodyHash !== citation.bodyHash;
  const anchor = locateUniqueReaderQuote(citation.quoteText, currentParagraphs, citation.paragraphIndex);

  if (anchor.status === 'ambiguous') return result('ambiguous', null, sourceRevisedElsewhere);
  if (anchor.status === 'missing') return result('quote_removed', null, sourceRevisedElsewhere);
  if (anchor.status === 'moved') return result('quote_moved', anchor.paragraphIndex, sourceRevisedElsewhere);

  if (isLegacy) {
    // The old row stores only a whole-body hash. Preserve its exact v1 check;
    // never infer a paragraph hash from today's text.
    return sourceRevisedElsewhere
      ? result('hash_version_stale', anchor.paragraphIndex, true)
      : result('verified', anchor.paragraphIndex, false);
  }

  const currentParagraphHash = readerParagraphHash(currentParagraphs[anchor.paragraphIndex]!);
  if (citation.hashVersion !== READER_SOURCE_HASH_VERSION) return result('hash_version_stale', anchor.paragraphIndex, sourceRevisedElsewhere);
  return currentParagraphHash === citation.paragraphHash
    ? result('verified', anchor.paragraphIndex, sourceRevisedElsewhere)
    : result('paragraph_edited', anchor.paragraphIndex, sourceRevisedElsewhere);
}
