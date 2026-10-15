/** Streaming ECMAScript default lowercase + includes, including contextual Greek sigma. */
export function intakeFeedTextMatcher(query: string) {
  const needle = query.toLowerCase(),
    failure = new Uint32Array(needle.length);
  for (let i = 1, j = 0; i < needle.length; i++) {
    while (j && needle[i] !== needle[j]) j = failure[j - 1]!;
    if (needle[i] === needle[j]) j++;
    failure[i] = j;
  }
  type State = { at: number; found: boolean };
  let current: State = { at: 0, found: needle.length === 0 },
    sigma: State | undefined,
    precededCased = false,
    high = '';
  const feed = (state: State, text: string) => {
    for (let i = 0; i < text.length; i++) {
      while (state.at && text[i] !== needle[state.at]) state.at = failure[state.at - 1]!;
      if (text[i] === needle[state.at]) state.at++;
      if (state.at === needle.length) {
        state.found = true;
        state.at = failure[state.at - 1] || 0;
      }
    }
  };
  const point = (text: string) => {
    const ignorable = /\p{Case_Ignorable}/u.test(text),
      cased = /\p{Cased}/u.test(text);
    if (sigma && !ignorable) {
      if (!cased) current = sigma;
      sigma = undefined;
    }
    if (text === 'Σ' && precededCased) {
      sigma = { ...current };
      feed(sigma, 'ς');
      feed(current, 'σ');
    } else {
      const lower = text.toLowerCase();
      feed(current, lower);
      if (sigma) feed(sigma, lower);
    }
    if (!ignorable) precededCased = cased;
  };
  return {
    push(text: string) {
      for (let i = 0; i < text.length; i++) {
        const unit = text[i]!;
        if (high) {
          if (/[\uDC00-\uDFFF]/.test(unit)) {
            point(high + unit);
            high = '';
            continue;
          }
          point(high);
          high = '';
        }
        if (/[\uD800-\uDBFF]/.test(unit)) high = unit;
        else point(unit);
      }
    },
    finish() {
      if (high) {
        point(high);
        high = '';
      }
      return (sigma || current).found;
    },
  };
}
