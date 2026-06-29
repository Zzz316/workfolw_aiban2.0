import cv2
import numpy as np

class AI():
	def chushihua(self,step):
		self.step=step
		self.ai_sum = []
		for i in range(len(self.step)):
			self.ai_sum.append(0)
		print(self.ai_sum)
	def identify(self,shedingxinxi,shibiexinxi):
		group_id_set = shedingxinxi[0]
		source_id_set = shedingxinxi[1]
		model_id_set = shedingxinxi[2]
		biaoqian = shedingxinxi[3]
		zhenshu = shedingxinxi[4]
		thresh = shedingxinxi[5]
		roi = np.array(shedingxinxi[6], np.int32).reshape((-1, 1, 2))
		# print(roi)
		for i in range(len(self.step)):
			# print(self.step[i][0:3])
			if [group_id_set,source_id_set,model_id_set,biaoqian] == self.step[i][0:4]:
				# print(type(model_id_set))
				if type(model_id_set) is int:
					for box in shibiexinxi[2].getModelInferBoxs(model_id_set):
						rect = box.getRect()
						pt1 = (rect[0], rect[1])
						if group_id_set == shibiexinxi[0] and source_id_set == shibiexinxi[1] and biaoqian == box.getLabelName() and box.getConfidence()>thresh and cv2.pointPolygonTest(roi, pt1, False)>=0:
							self.ai_sum[i] += 1
					if self.ai_sum[i] >= zhenshu:
						return True
					else:
						return False
				if type(model_id_set) is list:
					if type(biaoqian) is list:
						for box in shibiexinxi[2].getModelInferBoxs(model_id_set[0]):
							subbox = box.getModelBoxProperty(model_id_set[1])
							subname = ''
							subthresh = 0
							if len(subbox) > 0:
								subname = subbox[0].getLabelName()
								subthresh = subbox[0].getConfidence()
							rect = box.getRect()
							pt1 = (rect[0], rect[1])
							if group_id_set == shibiexinxi[0] and source_id_set == shibiexinxi[1] and biaoqian[0] == box.getLabelName() and box.getConfidence() > thresh and cv2.pointPolygonTest(roi, pt1, False) >= 0:
								if biaoqian[1] == subname and subthresh >thresh:
									self.ai_sum[i] += 1
						if self.ai_sum[i] >= zhenshu:
							return True
						else:
							return False
	def clearall(self,group_id_set,source_id_set):
		for i in range(len(self.step)):
			if self.step[i][0] == group_id_set and self.step[i][1] == source_id_set:
				self.ai_sum[i] = 0
	def clearbq(self,group_id_set,source_id_set,biaoqian):
		for i in range(len(self.step)):
			if self.step[i][0] == group_id_set and self.step[i][1] == source_id_set and self.step[i][2] == biaoqian:
				self.ai_sum[i] = 0