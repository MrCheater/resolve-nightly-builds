import AdmZip from 'adm-zip'
import { execSync } from 'child_process'
import fs from 'fs'
import https from 'https'
import path from 'path'
import rimraf from 'rimraf'
import Octokit from '@octokit/rest'
import minimist from 'minimist'

const { username, password, owner = 'reimagined', repo = 'resolve', branch = 'dev' } = minimist(process.argv.slice(2))
if(!username) {
  throw new Error('--username=XXX')
}
if(!password) {
  throw new Error('--password=YYY')
}
if(!owner) {
  throw new Error('--owner=reimagined')
}
if(!repo) {
  throw new Error('--repo=resolve')
}
if(!branch) {
  throw new Error('--branch=dev')
}

const octokit = new Octokit()
octokit.authenticate({
  type: 'basic',
  username,
  password
})

const rootDir = __dirname
const tempDir = path.join(rootDir, './temp')
const tarballsDir = path.join(rootDir, './tarballs')

const fetchGithubDevZip = () => new Promise((resolve, reject) => {
    const data = []
    let dataLen = 0

    const req = https.request({
      hostname: 'codeload.github.com',
      port: 443,
      path: `/${owner}/${repo}/zip/${branch}`,
      method: 'GET'
    }, (res) => {
      res.on('data', (chunk) => {
        data.push(chunk);
        dataLen += chunk.length;
      })

      res.on('end', () => {
        const buf = new Buffer(dataLen);

        for (let i=0, len = data.length, pos = 0; i < len; i++) {
          data[i].copy(buf, pos);
          pos += data[i].length;
        }

        resolve(buf)
      })
    })

    req.on('error', reject)
    req.end()
  })

const extractResolveDev = async (buf) => {
  await new Promise((resolve, reject) =>
    rimraf(tempDir, err => err ? reject(err) : resolve())
  )

  const zipArchive = new AdmZip(buf)

  const resolveDirName = tempDir+'/'+zipArchive.getEntries()[0].entryName.replace(/\/$/, '')

  return await new Promise((resolve, reject) =>
    zipArchive.extractAllToAsync(
      tempDir,
      true,
      err => err ? reject(err): resolve(resolveDirName)
    )
  )
}

const yarnResolveDev = async (resolveDirName) => {
  execSync('yarn', {
    cwd: resolveDirName,
    stdio: 'inherit',
    shell: '/bin/bash'
  })
}

const retrieveMonorepoPackages = async (result, baseDir) => {
  for(let elm of fs.readdirSync(baseDir)) {
    if(fs.existsSync(path.join(baseDir, elm, './package.json'))) {
      result[elm] = path.join(baseDir, elm)
      continue
    }
    try {
      await retrieveMonorepoPackages(result, path.join(baseDir, './', elm))
    } catch(err) {}
  }

  return result
}

const packageBaseGithubUrl = 'https://raw.githubusercontent.com/mrcheater/resolve-nightly-builds/master/packages/'

const patchPackageJsons = async (packages, isoTime) => {
  const sections = ['dependencies', 'devDependencies', 'peerDependencies']

  for(const packageName of Object.keys(packages)) {
     const packageJsonPath = path.join(packages[packageName], './package.json')
     const packageJson = JSON.parse(fs.readFileSync(packageJsonPath).toString())

     for(const section of sections) {
       if(!packageJson.hasOwnProperty(section)) continue
       for(const key of Object.keys(packageJson[section])) {
         if(packages.hasOwnProperty(key)) {
           packageJson[section][key] = `${packageBaseGithubUrl}${isoTime}/${key}.tgz`
         }
       }
     }

     fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2))
  }
}

const packPackages = async (packages, isoTime) => {
  await new Promise((resolve, reject) =>
    rimraf(tarballsDir, err => err ? reject(err) : resolve())
  )

  fs.mkdirSync(tarballsDir)

  const tarballs = []

  for(const packageName of Object.keys(packages)) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(packages[packageName], './package.json')).toString())
    const tarballName = `${packageName}.tgz`

    execSync(`yarn pack --filename=${path.join(tarballsDir, tarballName)}`, {
      cwd: packages[packageName],
      stdio: 'inherit'
    })

    tarballs.push(tarballName)
  }

  return tarballs
}

const publishTarballs = async (isoTime, tarballs) => {
  for(let tarballName of tarballs) {
    const tarballBase64 = fs.readFileSync(path.join(tarballsDir, './', tarballName)).toString('base64')

    await octokit.repos.createFile({
      owner: 'mrcheater',
      repo: 'resolve-nightly-builds',
      branch: 'master',
      path: `packages/${isoTime}/${tarballName}`,
      content: tarballBase64,
      message: 'Nightly builds update'
    })
  }

}

const main = async () => {
  const isoTime = (new Date()).toLocaleString().replace(/\s|:/g, '-')
  const buf = await fetchGithubDevZip()

  const resolveDirName = await extractResolveDev(buf)
  await yarnResolveDev(resolveDirName)
  const packages = await retrieveMonorepoPackages({}, path.join(resolveDirName, './packages'))
  await patchPackageJsons(packages, isoTime)
  const tarballs = await packPackages(packages, isoTime)
  await publishTarballs(isoTime, tarballs)

  console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
  console.log(`Nightly builds update within ${isoTime}`)
  console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
}

main()
