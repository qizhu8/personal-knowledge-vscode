export function mentionSearchText(text: string): string {
    let fence = "";
    return String(text || "").split(/\r?\n/).map(line => {
      const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        if (!fence) fence = marker;
        else if (fence === marker) fence = "";
        return "";
      }
      if (fence || /^\s*>/.test(line)) return "";
      let visible = "";
      for (let index = 0; index < line.length;) {
        if (line[index] !== "`") { visible += line[index++]; continue; }
        let end = index;
        while (end < line.length && line[end] === "`") end++;
        const marker = line.slice(index, end);
        const closing = line.indexOf(marker, end);
        if (closing < 0) { visible += " ".repeat(line.length - index); break; }
        visible += " ".repeat(closing + marker.length - index);
        index = closing + marker.length;
      }
      return visible;
    }).join("\n");
  }

export function allMentionNames(text: string): string[] {
    const names = (mentionSearchText(text).match(/(?<![\p{L}\p{N}_@])@(?:"[^"\n]{1,60}"|[\p{L}\p{N}_][\p{L}\p{N}_-]{0,59})/gu) || [])
      .map(token => token.slice(1).replace(/^"|"$/g, ""));
    return names.filter((name, index) => names.findIndex(candidate => candidate.toLocaleLowerCase() === name.toLocaleLowerCase()) === index);
  }

