//docs: https://octokit.github.io/node-github
const fs = require('fs');
const csvParse = require('csv-parse/lib/sync');
const request = require('request-promise');
const _ = require('lodash');

const { Octokit } = require("octokit");
const {
  restEndpointMethods,
} = require("@octokit/plugin-rest-endpoint-methods");
const MyOctokit = Octokit.plugin(restEndpointMethods);
const octokit = new MyOctokit({ 
  auth: fs.readFileSync('./github.token').toString() 
});

// const octokit = require('@octokit/rest')();
// octokit.authenticate({
//   type: 'oauth',
//   token: fs.readFileSync('./github.token').toString()
// })

const CANVAS_API_BASE = 'https://canvas.uw.edu/api/v1';
const CANVAS_KEY = fs.readFileSync('./canvas.key').toString();


/** Read Assignment Info **/

//Overall access stubs
const COURSE = require('./course.json');

//get single assignment from command line args (as -p argument; specify repo slug)
//get score from assignment (as -s, percentage number)
const args = require('minimist')(process.argv.slice(2));
if(args.p) {
  COURSE.assignments = COURSE.assignments.filter(a => a.repo_slug == args.p)
}
const SCORE = args.s || 100


/** Scoring Script **/

//score ALL of the submissions in the course list
async function scoreAllAssignments() {
  const students = await getStudents('./students.csv');

  for(assignment of COURSE.assignments){
      await scoreSubmission(students, assignment).catch(console.error);
  }
}
scoreAllAssignments(); //run it


//score a single assignment for given students
async function scoreSubmission(students, assignment){
  let totalComplete = 0;
  for(student of students) {
    console.log(`Scoring ${assignment.repo_slug} for ${student.display_name}`);

    const checks = await octokit.rest.checks.listForRef({
      owner: COURSE.github_org,
      repo: assignment.repo_slug+'-'+student.github,
      ref: assignment.branch || 'main', //default to main
    }).catch((err) => {
      console.log("Error accessing Githhub:", err.response.data.message);
    })


    try {
      const sorted = checks.data.check_runs
        .filter(check => check.name == "test") //only get Jest Test TODO: UPDATE ME!
        .sort((a, b) => { //get most recent
          return new Date(b.completed_at) == new Date(a.completed_at)
        })
  
      if(sorted[0].conclusion === 'success'){
        console.log(`...complete!`)
        await markComplete(student, assignment);
        totalComplete++;
      } else {
        console.log(`...INCOMPLETE`);
      }
    } catch(err) {
      console.log(`...INCOMPLETE`);
    }


  }
  console.log(`Complete submissions: ${totalComplete}/${students.length}`)
}

//Mark a particular student's assignment as complete (100%) in Canvas
async function markComplete(student, assignment) {
  let url = CANVAS_API_BASE + `/courses/${COURSE.canvas_id}/assignments/${assignment.canvas_id}/submissions/${student.canvas_id}`+`?access_token=${CANVAS_KEY}`;
  let req = { method:'PUT', uri: url, form: {submission: {posted_grade:SCORE+'%'}} }; //request
  return request(req).catch((err) => {
    console.error("Error marking submission: ", err.message);
  });
}



//read and compile student data (from Canvas and `students.csv`)
async function getStudents(studentFile) {
  let studentGitHubs = csvParse(fs.readFileSync(studentFile), {'columns':true});
  let canvasIds = await getEnrollments();
  let students = canvasIds.map((student) => {
    let match =  _.find(studentGitHubs, {uwnetid: student.uwnetid});
    return _.merge(student,match);
  })
  students = _.sortBy(students, ['display_name']); //ordering

  let githubLess = students.filter((s)=> s.github === undefined);
  if(githubLess.length > 0){
    console.log("Enrolled students without a GitHub account:")
    githubLess.forEach(console.log);
  }

  return students;
}

//fetch all student canvasIds from Canvas API
async function getEnrollments(){
  let PER_PAGE = 100;
  let url = CANVAS_API_BASE + `/courses/${COURSE.canvas_id}/enrollments?per_page=${PER_PAGE}&type=StudentEnrollment&access_token=${CANVAS_KEY}`
  let req = { method:'GET', uri: url, resolveWithFullResponse: true }; //request  
  let enrollmentsRes = await request(req); //has full data
  let enrollments = JSON.parse(enrollmentsRes.body); //get initial enrollments
  let studentIds = enrollments.map((item) => {
    return {
      canvas_id: item.user.id, 
      uwnetid: item.user.login_id,
      display_name: item.user.sortable_name
    }
  });

  let paginationLinks = enrollmentsRes.caseless.dict.link;
  let nextLink = paginationLinks.split(",").filter((link) => link.includes("next"))[0]
  if(nextLink) { //if paginated
    let nextLinkUrl = nextLink.slice(1, nextLink.indexOf('>'))
    enrollments = await request({method:'GET', uri:`${nextLinkUrl}&access_token=${CANVAS_KEY}`}).then(JSON.parse) //get the page
    studentIds = studentIds.concat(enrollments.map((item) => {
      return {
        canvas_id: item.user.id, 
        uwnetid: item.user.login_id,
        display_name: item.user.sortable_name
      }
    }))
  }

  return studentIds;
}
