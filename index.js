const { GitHub } = require('@actions/github')
const core = require('@actions/core')

async function run () {
  const token = core.getInput('token')
  const team = core.getInput('team')
  const org = core.getInput('org')
  const fullTeamName = `${org}/${team}`
  const since = core.getInput('since') !== ''
    ? core.getInput('since') : '2020-01-01'
  const projectBoard = core.getInput('project-board')
  const columnId = parseInt(core.getInput('project-column'), 10)
  const ignoreTeam = core.getInput('ignore-team')
  const body = core.getInput('comment-body')
  const includeRepos = core.getInput('include-repos') !== ''
    ? core.getInput('include-repos').split(',').map(x => x.trim()) : []
  const ignoreRepos = core.getInput('ignore-repos') !== ''
    ? core.getInput('ignore-repos').split(',').map(x => x.trim()) : []
  const ignoreLabels = core.getInput('ignore-labels') !== ''
    ? core.getInput('ignore-labels').split(',').map(x => x.trim()) : []
  let ignoreAuthors = core.getInput('ignore-authors') !== ''
    ? core.getInput('ignore-authors').split(',').map(x => x.trim()) : []
  let ignoreCommenters = core.getInput('ignore-commenters') !== ''
    ? core.getInput('ignore-commenters').split(',').map(x => x.trim()) : []
  const octokit = new GitHub(token)

  const projectInfo = projectBoard ? await getProjectMetaData(projectBoard, org) : undefined

  // Only include-repos OR ignore-repos can be passed in but not both.
  if (includeRepos.length > 0 && ignoreRepos.length > 0) {
    throw new Error('Pass either include-repos or ignore-repos as an option but not both.')
  }

  // Create a list of users to ignore in the search query
  let teamMembers = []
  if (ignoreTeam === '') {
    teamMembers = await getTeamLogins(octokit, org, team)
  } else {
    teamMembers = await getTeamLogins(octokit, org, ignoreTeam)
  }
  ignoreAuthors = ignoreAuthors.concat(teamMembers)
  ignoreCommenters = ignoreCommenters.concat(teamMembers)

  // Assemble and run the issue/pull request search query
  const issues = await getTeamPingIssues(octokit, org, fullTeamName, ignoreAuthors, ignoreCommenters, since, projectInfo, includeRepos, ignoreRepos, ignoreLabels)

  if (issues.data.incomplete_results === false) {
    console.log('🌵🌵🌵 All search results were found. 🌵🌵🌵')
  } else {
    console.log('🐢 The search result indicated that results may not be complete. This doesn\'t necessarily mean that all results weren\'t returned. See https://docs.github.com/en/rest/reference/search#timeouts-and-incomplete-results for details.')
  }

  if (issues.data.items.length === 0) {
    console.log('No new team pings. 💫🦄🌈🦩✨')
    core.setOutput('foundURLs', JSON.stringify([]))
  }

  console.log(`🚨 Search query found ${issues.data.items.length} issues and prs. 🚨`)

  if (columnId && projectBoard) {
    console.log('Adding items to project board...')
    for (const issue of issues.data.items) {
      let [, , , owner, repo, contentType, number] = issue.html_url.split('/')
      contentType = contentType === 'issues' ? 'Issue' : 'PullRequest'
      await addProjectCard(octokit, owner, repo, number, contentType, columnId)
    }
  }

  if (body !== '') {
    console.log('Commenting on each issue...')
    for (const issue of issues.data.items) {
      const [, , , owner, repo, , number] = issue.html_url.split('/')
      const comment = await octokit.issues.createComment({
        issue_number: number,
        owner: owner,
        repo: repo,
        body: body
      })
      if (comment.status !== 201) {
        throw new Error(`Unable to create a comment in #${issue.html_url} - ${comment.status}.`)
      }
    }
  }

  const urls = issues.data.items.map(item => item.html_url)

  console.log('Items found: ' + urls)

  core.setOutput('foundURLs', JSON.stringify(urls))
}

async function getTeamPingIssues (octokit, org, team, authors, commenters, since = '2019-01-01', projectBoard, includeRepos, ignoreRepos, ignoreLabels) {
  // Search for open issues in repositories owned by `org`
  // and includes a team mention to `team`
  let query = `per_page=100&q=is%3Aopen+org%3A${org}+team%3A${team}`
  for (const author of authors) {
    query = query.concat(`+-author%3A${author}`)
  }
  for (const commenter of commenters) {
    query = query.concat(`+-commenter%3A${commenter}`)
  }

  // Add the created since date query
  query = query.concat(`+created%3A%3E${since}`)

  if (includeRepos.length > 0) {
    // Add include repos query
    includeRepos.forEach(elem => {
      query = query.concat(`+repo%3A${elem}`)
    })
  } else if (ignoreRepos.length > 0) {
    // Add ignore repos query
    ignoreRepos.forEach(elem => {
      query = query.concat(`+-repo%3A${elem}`)
    })
  }

  // Add ignore labels query
  ignoreLabels.forEach(elem => {
    query = query.concat(`+-label%3A${elem}`)
  })

  // Ignore issues already on the project board, if a board was specified
  if (projectBoard) {
    const ref = projectBoard.repo !== undefined
      ? `${projectBoard.owner}%2F${projectBoard.repo}` : projectBoard.owner
    query = query.concat(`+-project%3A${ref}%2F${projectBoard.number}`)
  }

  console.log(`🔎 Searh query 🔎 ${query}`)
  return await octokit.request(`GET /search/issues?${query}`)
}

async function getProjectMetaData (projectUrl, org) {
  const projectAttr = projectUrl.split('/')

  if (projectAttr[3] === 'orgs') {
    return { owner: projectAttr[4], number: parseInt(projectAttr[6], 10) }
  } else if (projectAttr[3] === org) {
    return { owner: projectAttr[3], number: parseInt(projectAttr[6], 10), repo: projectAttr[4] }
  } else {
    return console.log(`The project URL format is malformed and won't be included: ${projectUrl}`)
  }
}

async function addProjectCard (octokit, owner, repo, number, contentType, columnId) {
  let contentRef = ''
  if (contentType === 'Issue') {
    contentRef = await octokit.issues.get({
      owner: owner,
      repo: repo,
      issue_number: number
    })
  } else {
    contentRef = await octokit.pulls.get({
      owner: owner,
      repo: repo,
      pull_number: number
    })
  }
  const res = await octokit.projects.createCard({
    column_id: columnId,
    content_id: contentRef.data.id,
    content_type: contentType
  })

  if (res.status !== 201) {
    throw new Error(`Unable to create a project card for ${contentRef} - ${res.status}.`)
  }

  return console.log(`🔖 Successfully created a new card in column #${columnId} for ${contentType} #${number} from ${owner}/${repo}!`)
}

async function getTeamLogins (octokit, org, team) {
  const teamMembers = await octokit.teams.listMembersInOrg({
    org: org,
    team_slug: team
  })
  return teamMembers.data.map(member => member.login)
}

run()
  .then(
    (response) => { console.log(`Finished running: ${response}`) },
    (error) => {
      console.log(`#ERROR# ${error}`)
      process.exit(1)
    }
  )
