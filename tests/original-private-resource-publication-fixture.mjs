export const privatePublicationFixtureBytes = Object.freeze({
  "a.PNG": Buffer.from("SYNTHETIC_PRIVATE_RESOURCE_A"),
  "b.BIN": Buffer.from("SYNTHETIC_PRIVATE_RESOURCE_B"),
});
export const seedOriginalPrivateResourcePublication = `
  const rows={};
  for(const [kind,area] of [["note","notes"],["skill","skills"],["paper","papers"]]){
    const body="Original private-resource owner\\n"
      +"![one](../Private/_assets/a.PNG?q=1#view)\\n[other](../Private/_assets/b.BIN)\\n"
      +'<img src="../Private/_assets/a.PNG?html=1#image">\\n'
      +"[legacy]: <../Private/_assets/b.BIN?definition=1#doc>\\n"
      +"\`![ignored](../_assets/example.PNG)\`\\n\`\`\`md\\n![example](../_assets/example.BIN)\\n\`\`\`\\n"
      +(kind==="note"?"[kept](Before.assets/existing.bin)\\n":"");
    store[kind+"Upsert"]({slug:"Old/Before",title:"Before",name:"Before",category:"Old",type:"general",content:body,
      ...(kind==="paper"?{file:"../Private/_assets/a.PNG?file=1#attachment"}:{})});
    for(const [name,value] of [["a.PNG","SYNTHETIC_PRIVATE_RESOURCE_A"],["b.BIN","SYNTHETIC_PRIVATE_RESOURCE_B"]]){
      const bytes=Buffer.from(value);
      assets.importMarkdownAssetBundle(root,[{type:area,path:"Private/_assets/"+name,data:bytes.toString("base64"),
        digest:"sha256:"+require("node:crypto").createHash("sha256").update(bytes).digest("hex")}],
        [{area,path:"Old/Before.md",content:body}]);
    }
    if(kind==="note")assets.saveMarkdownAsset(root,area,"Old/Before.md","existing.bin",Buffer.from([9,8,7]));
    store[kind+"Upsert"]({slug:"Private/Secret",title:"Secret",name:"Secret",category:"Private",type:"general",
      content:"SYNTHETIC_PRIVATE_REFERRER\\n![shared private resource](_assets/a.PNG)\\n"});
    rows[kind]=store[kind+"Get"](kind==="skill"?"Before":"Old/Before");
  }
  return rows;
`;
