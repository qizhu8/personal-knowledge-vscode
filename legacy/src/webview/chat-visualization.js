(() => {
  globalThis.PkmChatVisualization = ({ post }) => {
    const button = document.getElementById("visualization");
    let chatId;
    button.onclick = () => { if (chatId) post("openVisualizationWindow", { chatId }); };
    return {
      setChat(id) { chatId = id; button.disabled = !id; },
      dispose() { button.onclick = null; }
    };
  };
})();
