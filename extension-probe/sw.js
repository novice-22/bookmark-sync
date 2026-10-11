// 아이콘 클릭 시 진단 페이지를 새 탭으로 연다. 그 외에는 아무 동작도 하지 않는다.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('probe.html') })
})
