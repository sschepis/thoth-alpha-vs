import type { DossierSection, DossierSource } from './DossierManager';

export interface DossierDiff {
    addedClaims: string[];
    removedClaims: string[];
    addedSources: DossierSource[];
    removedSources: DossierSource[];
    contradictions: { claim1: string; claim2: string }[];
}

function extractClaims(sections: DossierSection[]): string[] {
    const claims: string[] = [];
    for (const section of sections) {
        const sentences = section.body_md
            .replace(/\$\$[\s\S]*?\$\$/g, '[math]')
            .replace(/\$[^$]+\$/g, '[math]')
            .replace(/```[\s\S]*?```/g, '')
            .split(/(?<=[.!?])\s+/)
            .map(s => s.trim())
            .filter(s => s.length > 20 && !s.startsWith('#'));
        claims.push(...sentences);
    }
    return claims;
}

function normalizeForComparison(text: string): string {
    return text
        .toLowerCase()
        .replace(/\[math\]/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function similarity(a: string, b: string): number {
    const aNorm = normalizeForComparison(a);
    const bNorm = normalizeForComparison(b);
    if (aNorm === bNorm) { return 1; }

    const aWords = new Set(aNorm.split(' '));
    const bWords = new Set(bNorm.split(' '));
    const intersection = [...aWords].filter(w => bWords.has(w)).length;
    const union = new Set([...aWords, ...bWords]).size;
    return union > 0 ? intersection / union : 0;
}

export function diffDossiers(
    oldSections: DossierSection[],
    newSections: DossierSection[],
    oldSources: DossierSource[],
    newSources: DossierSource[]
): DossierDiff {
    const oldClaims = extractClaims(oldSections);
    const newClaims = extractClaims(newSections);

    const matchedOld = new Set<number>();
    const matchedNew = new Set<number>();

    for (let i = 0; i < oldClaims.length; i++) {
        for (let j = 0; j < newClaims.length; j++) {
            if (matchedNew.has(j)) { continue; }
            if (similarity(oldClaims[i], newClaims[j]) > 0.6) {
                matchedOld.add(i);
                matchedNew.add(j);
                break;
            }
        }
    }

    const removedClaims = oldClaims.filter((_, i) => !matchedOld.has(i));
    const addedClaims = newClaims.filter((_, i) => !matchedNew.has(i));

    const oldUrls = new Set(oldSources.map(s => s.url).filter(Boolean));
    const newUrls = new Set(newSources.map(s => s.url).filter(Boolean));
    const addedSources = newSources.filter(s => s.url && !oldUrls.has(s.url));
    const removedSources = oldSources.filter(s => s.url && !newUrls.has(s.url));

    const contradictions: { claim1: string; claim2: string }[] = [];
    const negationPatterns = [
        /\bnot\b/i, /\bno\b/i, /\bnever\b/i, /\bwithout\b/i,
        /\bfails?\b/i, /\bincorrect/i, /\bfalse\b/i, /\bdisproven\b/i
    ];

    for (const removed of removedClaims) {
        for (const added of addedClaims) {
            const topicSimilarity = similarity(removed, added);
            if (topicSimilarity > 0.3 && topicSimilarity < 0.7) {
                const removedHasNeg = negationPatterns.some(p => p.test(removed));
                const addedHasNeg = negationPatterns.some(p => p.test(added));
                if (removedHasNeg !== addedHasNeg) {
                    contradictions.push({ claim1: removed, claim2: added });
                }
            }
        }
    }

    return { addedClaims, removedClaims, addedSources, removedSources, contradictions };
}
