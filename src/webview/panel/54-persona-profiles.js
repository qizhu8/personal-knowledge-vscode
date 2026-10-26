function showUserProfileTab() {
  const detail = document.getElementById('detail');
  detail.textContent = 'Loading User Profile...';
  ask('userProfile', {}, null, true);
}

function userProfileOnSnapshot(data) {
  if (state.tab !== 'userProfile') return;
  const detail = document.getElementById('detail');
  const title = document.createElement('h2'); title.textContent = 'User Profile';
  const actions = document.createElement('div');
  const edit = document.createElement('button'); edit.className = 'tbtn'; edit.textContent = data.user ? 'Edit / manage User Profile' : 'Create User Profile';
  edit.onclick = () => ask('userProfileEdit', {}, edit);
  const refresh = document.createElement('button'); refresh.className = 'tbtn'; refresh.textContent = 'Refresh';
  refresh.onclick = () => ask('userProfile', {}, refresh);
  actions.append(edit, refresh);
  detail.replaceChildren(title, actions, PkmAgentHarness.profileCards(data, false));
}
