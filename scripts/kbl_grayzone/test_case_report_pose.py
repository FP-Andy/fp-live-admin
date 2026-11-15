"""Pose evidence must show only joints supported by confidence."""
import unittest
import numpy as np
from case_report import annotated


class CaseReportPoseTests(unittest.TestCase):
 def test_visible_joints_and_edges_only(self):
  image=np.zeros((100,100,3),dtype=np.uint8)
  points=[[0.,0.] for _ in range(17)];scores=[0.0]*17
  points[5]=[30.,30.];points[7]=[45.,30.];points[9]=[65.,30.]
  scores[5]=.9;scores[7]=.3;scores[9]=.1
  out=annotated(image,{'people':[]},{'people':[{'keypoints':points,'scores':scores}]})
  self.assertGreater(int(out[30,30].sum()),0)
  self.assertGreater(int(out[30,37].sum()),0)
  self.assertGreater(int(out[30,45].sum()),0)
  self.assertEqual(int(out[30,65].sum()),0)
  self.assertEqual(int(out[0,0].sum()),0)
  self.assertEqual(int(image.sum()),0)

if __name__=='__main__':unittest.main()
