//  this file manages the aws sources using the aws-cdk-lib

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dotenv from "dotenv";
import path = require("path");

// load the .env file
const rootDir = path.resolve(__dirname, "..");
dotenv.config({ path: path.resolve(rootDir, ".env") });

const githubToken = process.env.GITHUB_ACCESS_TOKEN || "";
const dockerUsername = process.env.DOCKER_USERNAME || "";
const dockerPassword = process.env.DOCKER_PASSWORD || "";
const projekctName = process.env.PROJECT_NAME || "my-project";
const githubBranch = process.env.GITHUB_BRANCH_TO_OBSERVE || "main";
const githubAccountName = process.env.GITHUB_ACCOUNT_NAME || "";
const githubRepoName = process.env.GITHUB_REPO_NAME || "";

export class AwsInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // create a new vpc with a public subnet
    const vpc = new cdk.aws_ec2.Vpc(this, "VPC", {
      maxAzs: 1,
      vpcName: `${projekctName}-vpc`,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: cdk.aws_ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // crate an security group that allows all traffic in and out and ssh on port 22
    const securityGroup = new cdk.aws_ec2.SecurityGroup(this, "SecurityGroup", {
      vpc,
      allowAllOutbound: true,
      securityGroupName: `${projekctName}-security-group`,
    });

    securityGroup.addIngressRule(
      cdk.aws_ec2.Peer.anyIpv4(),
      cdk.aws_ec2.Port.tcp(80),
      "allow http access from anywhere"
    );
    securityGroup.addIngressRule(
      cdk.aws_ec2.Peer.anyIpv4(),
      cdk.aws_ec2.Port.tcp(443),
      "allow https access from anywhere"
    );
    securityGroup.addIngressRule(
      cdk.aws_ec2.Peer.anyIpv4(),
      cdk.aws_ec2.Port.tcp(22),
      "allow ssh access from anywhere"
    );

    // create a userData script that installs codeDeploy agent and docker on ec2 instance launch and login to docker hub
    const script = cdk.aws_ec2.UserData.custom(`
      #!/bin/bash
      sudo yum update -y
      sudo yum install ruby -y
      sudo yum install wget -y
      cd /home/ec2-user
      wget https://aws-codedeploy-eu-central-1.s3.eu-central-1.amazonaws.com/latest/install
      chmod +x ./install
      sudo ./install auto
      sudo service codedeploy-agent start
      sudo amazon-linux-extras install docker -y
      sudo curl -L https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m) -o /usr/local/bin/docker-compose
      sudo chmod +x /usr/local/bin/docker-compose
      sleep 10
      sudo service docker start; sudo systemctl enable docker.service
      sudo docker login -u '${dockerUsername}' -p '${dockerPassword}'
    `);

    //  create an ec2 instance that runs in the public subnet and add inbound rules to allow traffic from port 80
    const ec2Instance = new cdk.aws_ec2.Instance(this, "Instance", {
      vpc,
      instanceType: new cdk.aws_ec2.InstanceType("t2.micro"),
      machineImage: cdk.aws_ec2.MachineImage.latestAmazonLinux2(),
      securityGroup: securityGroup,
      userData: script,
      instanceName: `${projekctName}-ec2`,
    });

    // add  the tag "dockerEc2" to the ec2 instance in order to find it later
    cdk.Tags.of(ec2Instance).add("source", "dockerEc2");

    // create a CICD pipleline that uses the "gitHubRepo" as source and stores the artifacts in the "s3Bucket"
    const pipeline = new cdk.aws_codepipeline.Pipeline(this, "Pipeline", {
      pipelineName: `${projekctName}-pipeline`,
      restartExecutionOnUpdate: true,
    });

    // create a source stage that uses the "gitHubRepo" as source and store the artifacts in the "s3Bucket" so we can use it later with codeDeploy
    const githubSourceStage = {
      stageName: "Source",
      actions: [
        new cdk.aws_codepipeline_actions.GitHubSourceAction({
          actionName: "GitHub_Source",
          owner: githubAccountName,
          repo: githubRepoName,
          branch: githubBranch,
          oauthToken: cdk.SecretValue.unsafePlainText(githubToken),
          output: new cdk.aws_codepipeline.Artifact(`${projekctName}-source`),
        }),
      ],
    };

    pipeline.addStage(githubSourceStage);

    // create new CodeDeploy deploymentgroup wich uses the ec2 instance as deployment target
    const deploymentGroup = new cdk.aws_codedeploy.ServerDeploymentGroup(
      this,
      "DeploymentGroup",
      {
        deploymentGroupName: `${projekctName}-deploymentGroup`,
        autoRollback: {
          failedDeployment: true,
        },
        deploymentConfig: cdk.aws_codedeploy.ServerDeploymentConfig.ALL_AT_ONCE,
        installAgent: false,
        ec2InstanceTags: new cdk.aws_codedeploy.InstanceTagSet({
          source: ["dockerEc2"],
        }),
      }
    );

    const deployStage = {
      stageName: "Deploy",
      actions: [
        new cdk.aws_codepipeline_actions.CodeDeployServerDeployAction({
          actionName: "CodeDeploy",
          deploymentGroup,
          input: githubSourceStage.actions[0].actionProperties.outputs![0],
        }),
      ],
    };

    pipeline.addStage(deployStage);

    /// the pipline creates a s3 bucket along with the pipeline, so we need to get the s3 bucket from the pipeline and grant the ec2 instance and the deploymentGroup access to the s3 bucket
    const s3Bucket = pipeline.artifactBucket;
    s3Bucket.grantReadWrite(deploymentGroup.role!);
    s3Bucket.grantReadWrite(ec2Instance.role!);

    // This will output the ec2 instance id to the terminal
    new cdk.CfnOutput(this, "ec2ID", {
      value: ec2Instance.instanceId,
    });
    new cdk.CfnOutput(this, "ec2DNS", {
      value: `http://${ec2Instance.instancePublicDnsName}`,
    });
    new cdk.CfnOutput(this, "region", { value: cdk.Stack.of(this).region });
  }
}
