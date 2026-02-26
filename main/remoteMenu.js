ipc.on('open-context-menu', function (e, data) {
  var menu = new Menu()

  if (global.extensions && data.options && data.options.tabId && data.options.params && global.getView) {
    try {
      var view = global.getView(data.options.tabId)
      if (view && view.webContents) {
        var extensionItems = global.extensions.getContextMenuItems(view.webContents, data.options.params)
        if (extensionItems && extensionItems.length > 0) {
          extensionItems.forEach(function (item) {
            menu.append(item)
          })
          menu.append(new MenuItem({ type: 'separator' }))
        }
      }
    } catch (err) {}
  }

  data.template.forEach(function (section) {
    section.forEach(function (item) {
      var id = item.click
      item.click = function () {
        e.sender.send('context-menu-item-selected', { menuId: data.id, itemId: id })
      }
      if (item.submenu) {
        for (var i = 0; i < item.submenu.length; i++) {
          (function (id) {
            item.submenu[i].click = function () {
              e.sender.send('context-menu-item-selected', { menuId: data.id, itemId: id })
            }
          })(item.submenu[i].click)
        }
      }
      menu.append(new MenuItem(item))
    })
    menu.append(new MenuItem({ type: 'separator' }))
  })
  menu.on('menu-will-close', function () {
    e.sender.send('context-menu-will-close', { menuId: data.id })
  })
  menu.popup({ x: data.x, y: data.y })
})
