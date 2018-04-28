import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import Promise from 'bluebird'
import _ from 'lodash'
import moment from 'moment'
import axios from 'axios'
import { createConfig } from './configurator'
import helpers from './helpers'
import util from './util'

import { print, isDeveloping, npmCmd, resolveModuleRootPath, resolveFromDir, resolveProjectFile } from './util'

const MODULES_URL = 'https://s3.amazonaws.com/botpress-io/all-modules.json'
const FETCH_TIMEOUT = 5000

module.exports = (logger, projectLocation, dataLocation, kvs) => {
  const log = (level, ...args) => {
    if (logger && logger[level]) {
      logger[level].apply(this, args)
    } else {
      print.apply(this, [level, ...args])
    }
  }

  const fetchAllModules = () => {
    return axios
      .get(MODULES_URL, { timeout: FETCH_TIMEOUT })
      .then(({ data }) => data)
      .catch(() => logger.error('Could not fetch modules'))
  }

  const loadModules = async (moduleDefinitions, botpress) => {
    let loadedCount = 0
    const loadedModules = {}

    await Promise.mapSeries(moduleDefinitions, async mod => {
      let loader = null
      try {
        // eslint-disable-next-line no-eval
        loader = eval('require')(mod.entry)
      } catch (err) {
        return logger.error(`Error loading module "${mod.name}": ` + err.message)
      }

      if (typeof loader !== 'object') {
        return logger.warn(`Ignoring module ${mod.name}. Invalid entry point signature.`)
      }

      mod.handlers = loader

      try {
        mod.configuration = createConfig({
          kvs: kvs,
          name: mod.name,
          botfile: botpress.botfile,
          projectLocation,
          options: loader.config || {}
        })
      } catch (err) {
        logger.error(`Invalid module configuration in module ${mod.name}:`, err)
      }

      try {
        loader.init && (await loader.init(botpress, mod.configuration, helpers))
      } catch (err) {
        logger.warn('Error during module initialization: ', err)
      }

      loadedModules[mod.name] = mod
      logger.info(`Loaded ${mod.name}, version ${mod.version}`)
      loadedCount++
    })

    if (loadedCount > 0) {
      logger.info(`Loaded ${loadedCount} modules`)
    }

    return loadedModules
  }

  const scanModules = () => {
    const packagePath = path.join(projectLocation, 'package.json')

    if (!fs.existsSync(packagePath)) {
      return logger.warn(
        'No package.json found at project root, ' + "which means botpress can't load any module for the bot."
      )
    }

    // eslint-disable-next-line no-eval
    const botPackage = eval('require')(packagePath)

    let deps = botPackage.dependencies || {}
    if (isDeveloping) {
      deps = _.merge(deps, botPackage.devDependencies || {})
    }

    return _.reduce(
      deps,
      (result, value, key) => {
        if (!util.isBotpressPackage(key)) {
          return result
        }
        const entry = resolveFromDir(projectLocation, key)
        if (!entry) {
          return result
        }
        const root = resolveModuleRootPath(entry)
        if (!root) {
          return result
        }

        // eslint-disable-next-line no-eval
        const modulePackage = eval('require')(path.join(root, 'package.json'))
        if (!modulePackage.botpress) {
          return result
        }

        return (
          result.push({
            name: key,
            root: root,
            homepage: modulePackage.homepage,
            settings: modulePackage.botpress,
            version: modulePackage.version,
            entry: entry
          }) && result
        )
      },
      []
    )
  }

  const listInstalledModules = () => {
    const packagePath = resolveProjectFile('package.json', projectLocation, true)
    const { dependencies } = JSON.parse(fs.readFileSync(packagePath))
    const prodDeps = _.keys(dependencies)

    return _.filter(prodDeps, util.isBotpressPackage)
  }

  const mapModuleList = modules => {
    const installed = listInstalledModules()
    return modules.map(mod => ({
      name: mod.name,
      stars: mod.github.stargazers_count,
      forks: mod.github.forks_count,
      docLink: mod.homepage,
      version: mod['dist-tags'].latest,
      keywords: mod.keywords,
      fullName: mod.github.full_name,
      updated: mod.github.updated_at,
      issues: mod.github.open_issues_count,
      icon: mod.package.botpress.menuIcon,
      description: mod.description,
      installed: _.includes(installed, mod.name),
      license: mod.license,
      author: !mod.author.name ? mod.author : mod.author.name,
      title: mod.title,
      category: mod.category,
      featured: mod.featured,
      popular: mod.popular,
      official: mod.official
    }))
  }

  const listAllCommunityModules = Promise.method(() => {
    if (!fs) {
      return [] // TODO Fetch & return
    }

    const modulesCachePath = path.join(dataLocation, './modules-cache.json')
    if (!fs.existsSync(modulesCachePath)) {
      fs.writeFileSync(
        modulesCachePath,
        JSON.stringify({
          modules: [],
          updated: null
        })
      )
    }

    const { modules, updated } = JSON.parse(fs.readFileSync(modulesCachePath))

    if (updated && moment().diff(moment(updated), 'minutes') <= 30) {
      return mapModuleList(modules)
    }

    return Promise.props({
      newModules: fetchAllModules()
    }).then(({ newModules }) => {
      if (!newModules || !newModules.length) {
        if (modules.length > 0) {
          logger.debug('Fetched invalid modules. Report this to the Botpress Team.')
          return mapModuleList(modules)
        } else {
          newModules = newModules || []
        }
      }

      fs.writeFileSync(
        modulesCachePath,
        JSON.stringify({
          modules: newModules,
          updated: new Date()
        })
      )

      return mapModuleList(newModules)
    })
  })

  const getRandomCommunityHero = Promise.method(() => {
    const modulesCachePath = path.join(dataLocation, './modules-cache.json')

    return listAllCommunityModules().then(() => {
      const { modules } = JSON.parse(fs.readFileSync(modulesCachePath))

      const module = _.sample(modules)

      if (!module) {
        return {
          username: 'danyfs',
          github: 'https://github.com/danyfs',
          avatar: 'https://avatars1.githubusercontent.com/u/5629987?v=3',
          contributions: 'many',
          module: 'botpress'
        }
      }

      const hero = _.sample(module.contributors)

      return {
        username: hero.login,
        github: hero.html_url,
        avatar: hero.avatar_url,
        contributions: hero.contributions,
        module: module.name
      }
    })
  })

  return {
    listAllCommunityModules,
    getRandomCommunityHero,
    listInstalled: listInstalledModules,
    _scan: scanModules,
    _load: loadModules
  }
}