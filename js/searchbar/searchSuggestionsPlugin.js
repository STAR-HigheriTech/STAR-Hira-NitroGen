var searchbarPlugins = require('searchbar/searchbarPlugins.js')

var urlParser = require('util/urlParser.js')
var searchEngine = require('util/searchEngine.js')

function parseSuggestions (results, engineName) {
  let suggestions = []

  if (!results || typeof results !== 'object') {
    return suggestions
  }

  switch (engineName) {
    case 'DuckDuckGo':
      if (Array.isArray(results) && results[1] && Array.isArray(results[1])) {
        suggestions = results[1].slice(0, 3)
      }
      break
    case 'Bing':
      if (Array.isArray(results) && results[1] && Array.isArray(results[1])) {
        suggestions = results[1].slice(0, 3)
      }
      break
    case 'Baidu':
      if (Array.isArray(results) && results.length > 1 && Array.isArray(results[1])) {
        suggestions = results[1].slice(0, 3)
      }
      break
    case 'Google':
      if (Array.isArray(results) && results.length > 1 && Array.isArray(results[1])) {
        suggestions = results[1].slice(0, 3)
      }
      break
    case 'Yahoo':
      if (Array.isArray(results) && results[1] && Array.isArray(results[1])) {
        suggestions = results[1].slice(0, 3)
      }
      break
    case 'Ecosia':
      if (Array.isArray(results) && Array.isArray(results[0])) {
        suggestions = results[0].slice(0, 3)
      }
      break
    case 'StartPage':
      if (Array.isArray(results) && results[1] && Array.isArray(results[1])) {
        suggestions = results[1].slice(0, 3)
      }
      break
    case 'Qwant':
      if (results.suggestions && Array.isArray(results.suggestions)) {
        suggestions = results.suggestions.slice(0, 3).map(s => s.query || s)
      }
      break
    default:
      if (Array.isArray(results) && results[1] && Array.isArray(results[1])) {
        suggestions = results[1].slice(0, 3)
      } else if (Array.isArray(results) && Array.isArray(results[0])) {
        suggestions = results[0].slice(0, 3)
      }
  }

  return suggestions
}

function showSearchSuggestions (text, input, inputFlags) {
  const currentEngine = searchEngine.getCurrent()
  const suggestionsURL = currentEngine.suggestionsURL

  if (!suggestionsURL) {
    searchbarPlugins.reset('searchSuggestions')
    return
  }

  if ((searchbarPlugins.getResultCount() - searchbarPlugins.getResultCount('searchSuggestions')) > 3) {
    searchbarPlugins.reset('searchSuggestions')
    return
  }

  const isBaidu = currentEngine.name === 'Baidu'

  if (isBaidu) {
    const script = document.createElement('script')
    const callbackName = 'baiduSuggestion_' + Date.now()
    const url = suggestionsURL.replace('%s', encodeURIComponent(text))

    window[callbackName] = function (results) {
      searchbarPlugins.reset('searchSuggestions')

      if (searchbarPlugins.getResultCount() > 3) {
        delete window[callbackName]
        return
      }

      if (results) {
        const suggestions = parseSuggestions(results, 'Baidu')
        suggestions.forEach(function (result) {
          var data = {
            title: result,
            url: result
          }

          if (urlParser.isPossibleURL(result)) {
            data.icon = 'carbon:earth-filled'
          } else {
            data.icon = 'carbon:search'
          }

          searchbarPlugins.addResult('searchSuggestions', data)
        })
      }

      delete window[callbackName]
      script.remove()
    }

    script.src = url + callbackName
    document.head.appendChild(script)
    return
  }

  fetch(suggestionsURL.replace('%s', encodeURIComponent(text)), {
    cache: 'force-cache'
  })
    .then(function (response) {
      return response.json()
    })
    .then(function (results) {
      searchbarPlugins.reset('searchSuggestions')

      if (searchbarPlugins.getResultCount() > 3) {
        return
      }

      if (results) {
        const suggestions = parseSuggestions(results, currentEngine.name)
        suggestions.forEach(function (result) {
          var data = {
            title: result,
            url: result
          }

          if (urlParser.isPossibleURL(result)) {
            data.icon = 'carbon:earth-filled'
          } else {
            data.icon = 'carbon:search'
          }

          searchbarPlugins.addResult('searchSuggestions', data)
        })
      }
    })
}

function initialize () {
  searchbarPlugins.register('searchSuggestions', {
    index: 4,
    trigger: function (text) {
      return !!text && text.indexOf('!') !== 0 && !tabs.get(tabs.getSelected()).private
    },
    showResults: debounce(showSearchSuggestions, 50)
  })
}

module.exports = { initialize }
